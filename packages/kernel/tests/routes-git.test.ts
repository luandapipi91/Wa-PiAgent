/**
 * git 域路由测试：HttpRouter 直测（不启服务），真 git 仓库注册进 mock ProjectStore。
 * 环境无 git 可执行文件时整文件跳过。
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { HttpRouter } from "../src/http-router";
import { createGitRoutes } from "../src/routes/git";

const GIT = Bun.which("git");
const d = GIT ? describe : describe.skip;

/** 同步跑 git（测试基建用） */
function git(args: string[], cwd: string): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0)
		throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
	return r.stdout;
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-git-route-"));
	git(["init", "-b", "master"], dir);
	git(["config", "user.email", "test@example.com"], dir);
	git(["config", "user.name", "Test"], dir);
	return dir;
}

function commit(dir: string, msg: string): void {
	writeFileSync(join(dir, `f-${Math.random().toString(36).slice(2)}.txt`), msg);
	git(["add", "-A"], dir);
	git(["commit", "-m", msg], dir);
}

let dirs: string[] = [];
let router: HttpRouter;
let broadcast: ReturnType<typeof mock>;
let repoDir: string;

/** mock ProjectStore：p1 → 真 git 仓库，plain → 非 git 目录 */
function setupRouter(projects: { id: string; cwd: string }[]) {
	router = new HttpRouter();
	broadcast = mock(() => {});
	const projectStore = {
		load: async () => ({ projects, sessions: [] }),
	} as any;
	createGitRoutes(broadcast)(router, async () => Response.json({}), {
		projectStore,
	});
}

beforeEach(() => {
	dirs = [];
	repoDir = makeRepo();
	dirs.push(repoDir);
	commit(repoDir, "init");
});

afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

d("GET /api/projects/:projectId/git/status", () => {
	it("git 仓库项目返回 200 GitStatusResult", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/status"),
		);
		expect(res).not.toBeNull();
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			isRepo: true,
			branch: "master",
			dirty: false,
			ahead: 0,
			behind: 0,
		});
	});
});

d("GET status 降级与边界", () => {
	it("非 git 目录返回 200 { isRepo:false, ... }", async () => {
		const plain = mkdtempSync(join(tmpdir(), "wa-pi-git-plain-"));
		dirs.push(plain);
		setupRouter([{ id: "p1", cwd: plain }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/status"),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			isRepo: false,
			branch: "",
			dirty: false,
			ahead: 0,
			behind: 0,
		});
	});
});

d("GET status 参数边界", () => {
	it("__system__ 项目返回 400", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/__system__/git/status"),
		);
		expect(res?.status).toBe(400);
	});

	it("项目不存在返回 404", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/no-such/git/status"),
		);
		expect(res?.status).toBe(404);
	});
});

d("git 不可用（未安装 git）降级", () => {
	/** 临时指向不存在的 git 二进制（Bun.which 对运行时 PATH 变更不敏感，走 WA_PI_GIT_BIN 覆盖） */
	async function withoutGit<T>(fn: () => Promise<T>): Promise<T> {
		const saved = process.env.WA_PI_GIT_BIN;
		process.env.WA_PI_GIT_BIN = "nonexistent-git-binary-for-test";
		try {
			return await fn();
		} finally {
			if (saved === undefined) delete process.env.WA_PI_GIT_BIN;
			else process.env.WA_PI_GIT_BIN = saved;
		}
	}

	it("status 返回 200 isRepo:false（不返回 500）", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await withoutGit(() =>
			router.handle(new Request("http://localhost/api/projects/p1/git/status")),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			isRepo: false,
			branch: "",
			dirty: false,
			ahead: 0,
			behind: 0,
		});
	});

	it("branches 降级 200 空分支列表（与 status 降级对齐，不返 400/500）", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await withoutGit(() =>
			router.handle(
				new Request("http://localhost/api/projects/p1/git/branches"),
			),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ current: "", branches: [] });
	});

	it("log 降级 200 空提交列表（与 status 降级对齐，不返 400/500）", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await withoutGit(() =>
			router.handle(new Request("http://localhost/api/projects/p1/git/log")),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ commits: [] });
	});
});

d("GET /api/projects/:projectId/git/branches", () => {
	it("git 仓库返回 200 { current, branches }", async () => {
		git(["branch", "feature-a"], repoDir);
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/branches"),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({
			current: "master",
			branches: ["feature-a", "master"],
		});
	});

	it("非 git 目录降级 200 空分支列表（与 status 降级语义对齐）", async () => {
		const plain = mkdtempSync(join(tmpdir(), "wa-pi-git-plain-"));
		dirs.push(plain);
		setupRouter([{ id: "p1", cwd: plain }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/branches"),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ current: "", branches: [] });
	});
});

d("GET /api/projects/:projectId/git/log", () => {
	it("返回提交列表；limit=2 只取最近 2 条", async () => {
		commit(repoDir, "第二次");
		commit(repoDir, "第三次");
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/log?limit=2"),
		);
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { commits: { subject: string }[] };
		expect(body.commits.map((c) => c.subject)).toEqual(["第三次", "第二次"]);
	});

	it("非 git 目录降级 200 空提交列表（与 status 降级语义对齐）", async () => {
		const plain = mkdtempSync(join(tmpdir(), "wa-pi-git-plain-"));
		dirs.push(plain);
		setupRouter([{ id: "p1", cwd: plain }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/log"),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ commits: [] });
	});

	it("非法 limit 容错为默认值（不报错）", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/log?limit=abc"),
		);
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { commits: unknown[] };
		expect(body.commits.length).toBe(1);
	});
});

d("corrupt 仓库（对象损坏）不误降级", () => {
	/** 造一个 HEAD 完好但 parent 提交对象损坏的仓库：
	 *  rev-parse --verify HEAD 通过（不走空仓库早退），git log 遍历 parent 失败 */
	function corruptRepo(): string {
		const dir = makeRepo();
		commit(dir, "first");
		commit(dir, "second");
		const parent = git(["rev-parse", "master~1"], dir).trim();
		const obj = join(
			dir,
			".git",
			"objects",
			parent.slice(0, 2),
			parent.slice(2),
		);
		chmodSync(obj, 0o644); // 松散对象只读，先清掉再覆写（Windows 清只读位）
		writeFileSync(obj, "junkjunkjunk");
		return dir;
	}

	it("log 返回 400 git.logFailed（真实 git 失败不降级）", async () => {
		const bad = corruptRepo();
		dirs.push(bad);
		setupRouter([{ id: "p1", cwd: bad }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/log"),
		);
		expect(res?.status).toBe(400);
		const body = (await res?.json()) as { failure?: { code?: string } };
		expect(body.failure?.code).toBe("git.logFailed");
	});

	it("branches 不误伤：仍 200（git branch 不遍历对象）", async () => {
		const bad = corruptRepo();
		dirs.push(bad);
		setupRouter([{ id: "p1", cwd: bad }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/branches"),
		);
		expect(res?.status).toBe(200);
	});
});

// limit 解析纯函数：默认 200、上限 1000、非法/负数/0 容错
describe("parseLogLimit", () => {
	it("缺省/非法 → 200；超上限 → 1000", async () => {
		const { parseLogLimit } = await import("../src/routes/git");
		expect(parseLogLimit(null)).toBe(200);
		expect(parseLogLimit("abc")).toBe(200);
		expect(parseLogLimit("0")).toBe(200);
		expect(parseLogLimit("-5")).toBe(200);
		expect(parseLogLimit("50")).toBe(50);
		expect(parseLogLimit("99999")).toBe(1000);
	});
});

d("POST /api/projects/:projectId/git/checkout", () => {
	it("切换成功返回 200 { ok:true, branch } 并广播 git:changed", async () => {
		git(["branch", "feature-a"], repoDir);
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/checkout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ branch: "feature-a" }),
			}),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true, branch: "feature-a" });
		expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).trim()).toBe(
			"feature-a",
		);
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith({
			type: "git:changed",
			projectId: "p1",
		});
	});

	it("缺少 branch 参数返回 400", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/checkout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(res?.status).toBe(400);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("分支不存在返回非 200（git.checkoutFailed）且不广播", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/checkout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ branch: "no-such-branch" }),
			}),
		);
		expect(res?.status).not.toBe(200);
		const body = (await res?.json()) as { failure?: { code?: string } };
		expect(body.failure?.code).toBe("git.checkoutFailed");
		expect(broadcast).not.toHaveBeenCalled();
	});
});

d("POST /api/projects/:projectId/git/branch", () => {
	it("创建成功返回 200 { ok:true, branch } 并广播 git:changed", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/branch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "feature-new" }),
			}),
		);
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true, branch: "feature-new" });
		expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).trim()).toBe(
			"feature-new",
		);
		expect(broadcast).toHaveBeenCalledWith({
			type: "git:changed",
			projectId: "p1",
		});
	});

	it("非法分支名（含 .. ）返回 400 且不调用 git", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/branch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "bad..name" }),
			}),
		);
		expect(res?.status).toBe(400);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("分支重名返回非 200（git.branchFailed）", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/branch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "master" }),
			}),
		);
		expect(res?.status).not.toBe(200);
		const body = (await res?.json()) as { failure?: { code?: string } };
		expect(body.failure?.code).toBe("git.branchFailed");
	});
});

d("POST /api/projects/:projectId/git/pull", () => {
	it("拉取成功返回 200 GitPullResult 并广播 git:changed", async () => {
		const origin = mkdtempSync(join(tmpdir(), "wa-pi-git-origin-"));
		dirs.push(origin);
		git(["init", "--bare", "-b", "master"], origin);
		const seed = mkdtempSync(join(tmpdir(), "wa-pi-git-seed-"));
		dirs.push(seed);
		git(["clone", origin, seed], tmpdir());
		git(["config", "user.email", "test@example.com"], seed);
		git(["config", "user.name", "Test"], seed);
		commit(seed, "init");
		git(["push", "-u", "origin", "master"], seed);
		const dir = mkdtempSync(join(tmpdir(), "wa-pi-git-clone-"));
		dirs.push(dir);
		git(["clone", origin, dir], tmpdir());

		setupRouter([{ id: "p1", cwd: dir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/pull", {
				method: "POST",
			}),
		);
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as {
			ok: boolean;
			alreadyUpToDate: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.alreadyUpToDate).toBe(true);
		expect(broadcast).toHaveBeenCalledWith({
			type: "git:changed",
			projectId: "p1",
		});
	});

	it("无上游返回非 200（git.pullFailed）且不广播", async () => {
		setupRouter([{ id: "p1", cwd: repoDir }]);
		const res = await router.handle(
			new Request("http://localhost/api/projects/p1/git/pull", {
				method: "POST",
			}),
		);
		expect(res?.status).not.toBe(200);
		const body = (await res?.json()) as { failure?: { code?: string } };
		expect(body.failure?.code).toBe("git.pullFailed");
		expect(broadcast).not.toHaveBeenCalled();
	});
});
