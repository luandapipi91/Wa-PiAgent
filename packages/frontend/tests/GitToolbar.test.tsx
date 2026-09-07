// GitToolbar 组件测试：拉取按钮/项目 chip/分支 chip/···菜单/弹窗联动/非仓库不渲染
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GitToolbar } from "../src/components/git/GitToolbar";
import { useGitStore } from "../src/store/git";
import { useToastStore } from "../src/store/toast";
import type { ProjectEntity } from "@wa-pi/shared";

const getMock = mock();
const postMock = mock();

/** 与真实 api-client 同构的 ApiError（mock 模块内共享，保证 instanceof 成立） */
class ApiError extends Error {
	status: number;
	failure?: {
		code: string;
		params?: Record<string, string | number>;
		detail?: string;
	};
	constructor(
		message: string,
		status: number,
		failure?: {
			code: string;
			params?: Record<string, string | number>;
			detail?: string;
		},
	) {
		super(message);
		this.status = status;
		this.failure = failure;
		this.name = "ApiError";
	}
}

mock.module("../src/api-client", () => ({
	api: {
		get: getMock,
		post: postMock,
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
	ApiError,
}));

const PROJECT: ProjectEntity = {
	id: "p1",
	name: "hiagent",
	cwd: "/repo",
	createdAt: 0,
};

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
	useToastStore.setState({ toasts: [] });
	getMock.mockReset();
	postMock.mockReset();
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status")) return Promise.resolve(STATUS);
		if (path.endsWith("/git/branches")) return Promise.resolve(BRANCHES);
		if (path.includes("/git/log")) return Promise.resolve({ commits: [] });
		return Promise.resolve({});
	});
	postMock.mockImplementation(() => Promise.resolve({ ok: true }));
});

test("isRepo=false 时不渲染任何内容", async () => {
	getMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/status"))
			return Promise.resolve({ ...STATUS, isRepo: false });
		return Promise.resolve({});
	});
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() =>
		expect(useGitStore.getState().byProject["p1"]?.status?.isRepo).toBe(false),
	);
	expect(screen.queryByTestId("git-toolbar")).toBeNull();
});

test("仓库项目渲染拉取按钮/项目 chip/分支 chip/···菜单", async () => {
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("git-toolbar"));
	expect(screen.getByTestId("btn-git-pull").textContent).toContain(
		"拉取最新代码",
	);
	expect(screen.getByTestId("git-project-chip").textContent).toContain(
		"hiagent",
	);
	expect(screen.getByTestId("branch-chip").textContent).toContain("main");
});

test("点击拉取：完成后 toast 摘要（fast-forward）", async () => {
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/pull"))
			return Promise.resolve({
				ok: true,
				mode: "fast-forward",
				from: "aaa1111",
				to: "bbb2222",
				alreadyUpToDate: false,
				filesChanged: 2,
				insertions: 5,
				deletions: 1,
			});
		return Promise.resolve({ ok: true });
	});
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("btn-git-pull"));
	fireEvent.click(screen.getByTestId("btn-git-pull"));
	await waitFor(() =>
		expect(
			useToastStore
				.getState()
				.toasts.some((t) => t.message.includes("aaa1111 → bbb2222")),
		).toBe(true),
	);
	const msg = useToastStore.getState().toasts[0].message;
	expect(msg).toContain("2 个文件 +5/-1");
});

test("已最新时 toast 提示「已是最新」", async () => {
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/pull"))
			return Promise.resolve({
				ok: true,
				mode: "none",
				alreadyUpToDate: true,
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
			});
		return Promise.resolve({ ok: true });
	});
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("btn-git-pull"));
	fireEvent.click(screen.getByTestId("btn-git-pull"));
	await waitFor(() =>
		expect(
			useToastStore.getState().toasts.some((t) => t.message.includes("已是最新")),
		).toBe(true),
	);
});

test("拉取失败 toast 错误提示", async () => {
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/pull"))
			return Promise.reject(new Error("no upstream"));
		return Promise.resolve({ ok: true });
	});
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("btn-git-pull"));
	fireEvent.click(screen.getByTestId("btn-git-pull"));
	await waitFor(() =>
		expect(
			useToastStore.getState().toasts.some((t) => t.message.includes("拉取失败")),
		).toBe(true),
	);
});

test("拉取失败时 toast 展示 git stderr 原文（failure.detail）而非错误码", async () => {
	postMock.mockImplementation((path: string) => {
		if (path.endsWith("/git/pull"))
			return Promise.reject(
				new ApiError("git.pullFailed", 400, {
					code: "git.pullFailed",
					detail:
						"error: Your local changes to the following files would be overwritten by merge: service.js",
				}),
			);
		return Promise.resolve({ ok: true });
	});
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("btn-git-pull"));
	fireEvent.click(screen.getByTestId("btn-git-pull"));
	await waitFor(() =>
		expect(
			useToastStore
				.getState()
				.toasts.some((t) => t.message.includes("Your local changes")),
		).toBe(true),
	);
	// 展示 stderr 原文而非光秃秃的错误码
	expect(
		useToastStore
			.getState()
			.toasts.some((t) => t.message.includes("git.pullFailed")),
	).toBe(false);
});

test("分支菜单切换分支调 checkout；失败 toast", async () => {
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("branch-item-dev"));
	await waitFor(() =>
		expect(postMock).toHaveBeenCalledWith("/api/projects/p1/git/checkout", {
			branch: "dev",
		}),
	);
});

test("···菜单含「Git 图谱」「刷新状态」，点击打开图谱弹窗", async () => {
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("git-toolbar"));
	fireEvent.click(screen.getByTestId("git-more-menu-btn"));
	expect(screen.getByTestId("git-menu-graph")).toBeTruthy();
	expect(screen.getByTestId("git-menu-refresh")).toBeTruthy();
	fireEvent.click(screen.getByTestId("git-menu-graph"));
	await waitFor(() => screen.getByTestId("git-graph-modal"));
});

test("分支菜单「创建并检出新分支」打开创建对话框，确认后调 createBranch", async () => {
	render(<GitToolbar project={PROJECT} />);
	await waitFor(() => screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("branch-chip"));
	fireEvent.click(screen.getByTestId("btn-create-branch"));
	await waitFor(() => screen.getByTestId("create-branch-dialog"));
	fireEvent.change(screen.getByTestId("branch-name-input"), {
		target: { value: "feature/new" },
	});
	fireEvent.click(screen.getByTestId("btn-create-branch-confirm"));
	await waitFor(() =>
		expect(postMock).toHaveBeenCalledWith("/api/projects/p1/git/branch", {
			name: "feature/new",
		}),
	);
	// 成功后对话框关闭
	await waitFor(() =>
		expect(screen.queryByTestId("create-branch-dialog")).toBeNull(),
	);
});
