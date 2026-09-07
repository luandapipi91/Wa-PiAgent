/**
 * git-service 单元测试：真 git 仓库（mkdtemp + git init）驱动。
 * 环境无 git 可执行文件时整文件跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const GIT = Bun.which("git");
const d = GIT ? describe : describe.skip;

/** 同步跑 git（测试基建用，非被测代码） */
function git(args: string[], cwd: string): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0)
		throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
	return r.stdout;
}

/** 建临时仓库：master 主分支 + 固定提交身份 */
function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-git-svc-"));
	git(["init", "-b", "master"], dir);
	git(["config", "user.email", "test@example.com"], dir);
	git(["config", "user.name", "Test"], dir);
	return dir;
}

/** 追加一次提交（内容随机避免空提交差异问题） */
function commit(dir: string, msg: string): void {
	writeFileSync(join(dir, `f-${Math.random().toString(36).slice(2)}.txt`), msg);
	git(["add", "-A"], dir);
	git(["commit", "-m", msg], dir);
}

let dirs: string[] = [];
beforeEach(() => {
	dirs = [];
});
afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

import { runGit, gitStatus, gitBranches, gitLog, gitCheckout, gitCreateBranch, gitPull } from "../src/git-service";

d("runGit", () => {
	it("执行成功返回 exitCode=0 与 stdout", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		const r = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("master");
	});

	it("非零退出返回 exitCode≠0 与 stderr（不抛错，由调用方判失败）", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		const r = await runGit(dir, ["checkout", "no-such-branch"]);
		expect(r.exitCode).not.toBe(0);
		expect(r.stderr).toContain("no-such-branch");
	});

	it("超时被 kill 并抛 KernelError git.timeout", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		// 用 bun 自身模拟挂死进程（gitBin 注入点兼作超时测试钩子）
		try {
			await runGit(dir, ["-e", "setTimeout(() => {}, 5000)"], {
				gitBin: process.execPath,
				timeoutMs: 100,
			});
			expect.unreachable("应抛 git.timeout");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("git.timeout");
		}
	});
});

d("gitStatus", () => {
	it("非 git 目录抛 KernelError git.notRepo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wa-pi-git-notrepo-"));
		dirs.push(dir);
		try {
			await gitStatus(dir);
			expect.unreachable("应抛 git.notRepo");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("git.notRepo");
		}
	});
});

d("gitStatus-正常仓库", () => {
	it("返回分支名/脏标记；无上游时 ahead/behind 为 0", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		let s = await gitStatus(dir);
		expect(s).toEqual({
			isRepo: true,
			branch: "master",
			dirty: false,
			ahead: 0,
			behind: 0,
		});
		writeFileSync(join(dir, "dirty.txt"), "x");
		s = await gitStatus(dir);
		expect(s.dirty).toBe(true);
	});
});

d("gitBranches", () => {
	it("返回当前分支与本地分支列表", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		git(["branch", "feature-a"], dir);
		const r = await gitBranches(dir);
		expect(r.current).toBe("master");
		expect(r.branches).toEqual(["feature-a", "master"]);
	});
});

d("gitLog", () => {
	it("解析提交历史：hash/parents/refs/author/subject，倒序", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "第一次提交");
		commit(dir, "第二次提交");
		const r = await gitLog(dir);
		expect(r.commits.length).toBe(2);
		const [head, root] = r.commits;
		expect(head.subject).toBe("第二次提交");
		expect(head.author).toBe("Test");
		expect(head.parents).toEqual([root.hash]);
		expect(head.refs).toEqual([
			{ kind: "head", name: "HEAD" },
			{ kind: "branch", name: "master" },
		]);
		expect(root.parents).toEqual([]);
	});
});

d("gitLog-空仓库", () => {
	it("无任何提交的仓库返回空数组（不抛错）", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		const r = await gitLog(dir);
		expect(r.commits).toEqual([]);
	});
});

d("gitCheckout", () => {
	it("切换到已存在分支后 gitStatus.branch 变更", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		git(["branch", "feature-a"], dir);
		await gitCheckout(dir, "feature-a");
		expect((await gitStatus(dir)).branch).toBe("feature-a");
	});
});

d("gitCheckout-失败", () => {
	it("分支不存在抛 KernelError git.checkoutFailed 且携带 stderr detail", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		try {
			await gitCheckout(dir, "no-such-branch");
			expect.unreachable("应抛 git.checkoutFailed");
		} catch (e) {
			const err = e as { code?: string; detail?: string };
			expect(err.code).toBe("git.checkoutFailed");
			expect(err.detail).toContain("no-such-branch");
		}
	});
});

d("gitCreateBranch", () => {
	it("创建并切换到新分支", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		await gitCreateBranch(dir, "feature-new");
		expect((await gitStatus(dir)).branch).toBe("feature-new");
		expect((await gitBranches(dir)).branches).toContain("feature-new");
	});

	it("分支重名抛 KernelError git.branchFailed", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		try {
			await gitCreateBranch(dir, "master");
			expect.unreachable("应抛 git.branchFailed");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("git.branchFailed");
		}
	});
});

d("gitPull", () => {
	it("已最新返回 alreadyUpToDate；远端有新提交则 fast-forward 并返回 from/to 与统计", async () => {
		const origin = mkdtempSync(join(tmpdir(), "wa-pi-git-origin-"));
		dirs.push(origin);
		git(["init", "--bare", "-b", "master"], origin);

		// 种子克隆：提交初始历史并推送，建立 origin/master
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

		const r1 = await gitPull(dir);
		expect(r1.ok).toBe(true);
		expect(r1.alreadyUpToDate).toBe(true);
		expect(r1.mode).toBe("none");

		commit(seed, "远端提交");
		git(["push"], seed);
		const r2 = await gitPull(dir);
		expect(r2.ok).toBe(true);
		expect(r2.mode).toBe("fast-forward");
		expect(r2.from).toBeTruthy();
		expect(r2.to).toBeTruthy();
		expect(r2.from).not.toBe(r2.to);
		expect(r2.filesChanged).toBeGreaterThan(0);
		// 全链路 12+ 个真实 git 子进程，天然耗时可超 bun 默认 5s（并行负载下更甚）
	}, 30000);
});

d("gitPull-失败", () => {
	it("无上游分支抛 KernelError git.pullFailed", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		try {
			await gitPull(dir);
			expect.unreachable("应抛 git.pullFailed");
		} catch (e) {
			expect((e as { code?: string }).code).toBe("git.pullFailed");
		}
	});
});

d("互斥", () => {
	it("并发 checkout/建分支全部成功（模块级队列串行，无 index.lock 竞争）", async () => {
		const dir = makeRepo();
		dirs.push(dir);
		commit(dir, "init");
		git(["branch", "b1"], dir);
		git(["branch", "b2"], dir);
		const results = await Promise.allSettled([
			gitCheckout(dir, "b1"),
			gitCreateBranch(dir, "b3"),
			gitCheckout(dir, "b2"),
			gitCheckout(dir, "master"),
		]);
		expect(results.map((r) => r.status)).toEqual([
			"fulfilled",
			"fulfilled",
			"fulfilled",
			"fulfilled",
		]);
		expect((await gitStatus(dir)).branch).toBe("master");
		expect((await gitBranches(dir)).branches).toContain("b3");
	});
});
