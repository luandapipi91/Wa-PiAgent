// git store 单元测试：按 projectId 缓存 git 状态，全部 mock api-client，不依赖真实后端
import { test, expect, beforeEach, mock } from "bun:test";
import { useGitStore } from "../src/store/git";
import { emitEventForTesting } from "../src/events";
import type { GitPullResult } from "@wa-pi/shared";

const getMock = mock();
const postMock = mock();
mock.module("../src/api-client", () => ({
	api: {
		get: getMock,
		post: postMock,
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

const STATUS = {
	isRepo: true,
	branch: "main",
	dirty: false,
	ahead: 0,
	behind: 0,
};
const BRANCHES = { current: "main", branches: ["main", "dev"] };

beforeEach(() => {
	useGitStore.setState({ byProject: {} });
	getMock.mockReset();
	postMock.mockReset();
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status")) return Promise.resolve(STATUS);
		if (path.endsWith("/git/branches")) return Promise.resolve(BRANCHES);
		return Promise.resolve({});
	});
	postMock.mockImplementation(() => Promise.resolve({ ok: true }));
});

test("refresh 拉取 status+branches 并按 projectId 缓存", async () => {
	await useGitStore.getState().refresh("p1");
	const entry = useGitStore.getState().byProject["p1"];
	expect(entry.status?.branch).toBe("main");
	expect(entry.branches?.branches).toEqual(["main", "dev"]);
	expect(entry.loading).toBe(false);
	expect(getMock).toHaveBeenCalledWith("/api/projects/p1/git/status");
	expect(getMock).toHaveBeenCalledWith("/api/projects/p1/git/branches");
});

test("非 git 项目 refresh 只发 status 一次，不再请求 branches", async () => {
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status"))
			return Promise.resolve({
				isRepo: false,
				branch: "",
				dirty: false,
				ahead: 0,
				behind: 0,
			});
		return Promise.resolve({ current: "", branches: [] });
	});
	await useGitStore.getState().refresh("p1");
	const entry = useGitStore.getState().byProject["p1"];
	// status 正常落 store，不被 branches 拖丢；branches 置空、无 error
	expect(entry.status?.isRepo).toBe(false);
	expect(entry.branches).toEqual({ current: "", branches: [] });
	expect(entry.loading).toBe(false);
	expect(entry.error).toBeNull();
	// 只发 status 一次，branches 不会被请求
	expect(getMock).toHaveBeenCalledTimes(1);
	expect(getMock).toHaveBeenCalledWith("/api/projects/p1/git/status");
	expect(getMock).not.toHaveBeenCalledWith("/api/projects/p1/git/branches");
});

test("checkout 调 POST 切换分支并刷新缓存", async () => {
	postMock.mockImplementation((path: string, body: unknown) => {
		if (path.endsWith("/git/checkout")) {
			expect(body).toEqual({ branch: "dev" });
			return Promise.resolve({ ok: true, branch: "dev" });
		}
		return Promise.resolve({ ok: true });
	});
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status"))
			return Promise.resolve({ ...STATUS, branch: "dev" });
		if (path.endsWith("/git/branches"))
			return Promise.resolve({ current: "dev", branches: ["main", "dev"] });
		return Promise.resolve({});
	});
	await useGitStore.getState().checkout("p1", "dev");
	expect(postMock).toHaveBeenCalledWith("/api/projects/p1/git/checkout", {
		branch: "dev",
	});
	// 切换成功后重新拉取，缓存反映新分支
	expect(useGitStore.getState().byProject["p1"].status?.branch).toBe("dev");
});

test("createBranch 创建并切换到新分支后刷新缓存", async () => {
	postMock.mockImplementation((path: string, body: unknown) => {
		if (path.endsWith("/git/branch")) {
			expect(body).toEqual({ name: "feature/x" });
			return Promise.resolve({ ok: true, branch: "feature/x" });
		}
		return Promise.resolve({ ok: true });
	});
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status"))
			return Promise.resolve({ ...STATUS, branch: "feature/x" });
		if (path.endsWith("/git/branches"))
			return Promise.resolve({
				current: "feature/x",
				branches: ["main", "dev", "feature/x"],
			});
		return Promise.resolve({});
	});
	await useGitStore.getState().createBranch("p1", "feature/x");
	expect(postMock).toHaveBeenCalledWith("/api/projects/p1/git/branch", {
		name: "feature/x",
	});
	expect(useGitStore.getState().byProject["p1"].branches?.current).toBe(
		"feature/x",
	);
});

test("pull 返回 GitPullResult，期间 pulling=true，结束后刷新缓存", async () => {
	const pullResult: GitPullResult = {
		ok: true,
		mode: "fast-forward",
		from: "aaa1111",
		to: "bbb2222",
		alreadyUpToDate: false,
		filesChanged: 3,
		insertions: 10,
		deletions: 2,
	};
	let resolvePull!: (v: unknown) => void;
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/pull"))
			return new Promise((r) => {
				resolvePull = r;
			});
		return Promise.resolve({ ok: true });
	});
	const p = useGitStore.getState().pull("p1");
	// 拉取进行中
	expect(useGitStore.getState().byProject["p1"].pulling).toBe(true);
	resolvePull(pullResult);
	const result = await p;
	expect(result).toEqual(pullResult);
	expect(postMock).toHaveBeenCalledWith("/api/projects/p1/git/pull");
	expect(useGitStore.getState().byProject["p1"].pulling).toBe(false);
	// pull 完成后刷新 status（ahead/behind 变化）
	expect(useGitStore.getState().byProject["p1"].status?.branch).toBe("main");
});

test("pull 失败后同样刷新缓存（清理过期的 ahead/behind 计数）", async () => {
	let rejectPull!: (e: unknown) => void;
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/pull"))
			return new Promise((_, rj) => {
				rejectPull = rj;
			});
		return Promise.resolve({ ok: true });
	});
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status"))
			return Promise.resolve({
				...STATUS,
				branch: "master",
				ahead: 0,
				behind: 0,
			});
		if (path.endsWith("/git/branches"))
			return Promise.resolve({ current: "master", branches: ["master"] });
		return Promise.resolve({});
	});
	const p = useGitStore.getState().pull("p1");
	rejectPull(new Error("git.pullFailed"));
	await expect(p).rejects.toThrow();
	expect(useGitStore.getState().byProject["p1"].pulling).toBe(false);
	// 失败后也刷新了 status（mock 返回 master，证明 refresh 被调用、过期计数被清理）
	expect(useGitStore.getState().byProject["p1"].status?.branch).toBe("master");
});

test("loadLog 按 limit 拉取提交列表", async () => {
	const commits = [
		{
			hash: "abc1234567890",
			parents: [],
			refs: [{ kind: "head", name: "HEAD" }],
			author: "co",
			date: "2026-09-06T10:00:00+08:00",
			subject: "init",
		},
	];
	getMock.mockImplementation((path: string) => {
		if (path.includes("/git/log")) return Promise.resolve({ commits });
		return Promise.resolve({});
	});
	const result = await useGitStore.getState().loadLog("p1", 200);
	expect(getMock).toHaveBeenCalledWith("/api/projects/p1/git/log?limit=200");
	expect(result).toHaveLength(1);
	expect(result[0].hash).toBe("abc1234567890");
});

test("SSE git:changed 触发对应项目 refresh", async () => {
	getMock.mockClear();
	emitEventForTesting({ type: "git:changed", projectId: "p1" } as any);
	// refresh 是异步的，等一拍
	await new Promise((r) => setTimeout(r, 10));
	expect(getMock).toHaveBeenCalledWith("/api/projects/p1/git/status");
});

test("SSE git:changed 无 projectId 时不触发 refresh", async () => {
	getMock.mockClear();
	emitEventForTesting({ type: "git:changed" } as any);
	await new Promise((r) => setTimeout(r, 10));
	expect(getMock).not.toHaveBeenCalled();
});
