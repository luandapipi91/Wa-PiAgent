/**
 * git-watcher 测试：外部（应用外）变更仓库时广播 git:changed。
 * 覆盖：外部 checkout 触发广播、非 git 目录静默忽略、worktree（.git 为 gitdir 文件）可监听。
 * 环境无 git 可执行文件时整文件跳过。
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
	ensureGitWatch,
	stopAllGitWatchers,
} from "../src/git-watcher";

const GIT = Bun.which("git");
const d = GIT ? describe : describe.skip;

function git(args: string[], cwd: string): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0)
		throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
	return r.stdout;
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-git-watch-"));
	git(["init", "-b", "master"], dir);
	git(["config", "user.email", "test@example.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "a.txt"), "v1\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return dir;
}

let dirs: string[] = [];

afterEach(async () => {
	stopAllGitWatchers();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs = [];
});

/** 轮询等待 broadcast 被调用（fs.watch 触发是异步的，Windows 上可能慢） */
async function waitBroadcast(
	broadcast: ReturnType<typeof mock>,
	timeoutMs = 8000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (broadcast.mock.calls.length > 0) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("等待 git:changed 广播超时");
}

d("git-watcher 动态刷新", () => {
	it("外部 checkout 分支后广播 git:changed（带 projectId）", async () => {
		const repo = makeRepo();
		dirs.push(repo);
		git(["branch", "outside"], repo);
		const broadcast = mock(() => {});

		ensureGitWatch("p1", repo, broadcast);
		expect(broadcast).not.toHaveBeenCalled();

		// 模拟「在别的地方切换了分支」：不经路由，直接改仓库
		git(["checkout", "outside"], repo);

		await waitBroadcast(broadcast);
		expect(broadcast).toHaveBeenCalledWith({
			type: "git:changed",
			projectId: "p1",
		});
	});

	it("非 git 目录静默忽略（不抛错、不广播）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wa-pi-git-watch-plain-"));
		dirs.push(dir);
		const broadcast = mock(() => {});
		expect(() => ensureGitWatch("p2", dir, broadcast)).not.toThrow();
		writeFileSync(join(dir, "x.txt"), "hi");
		await new Promise((r) => setTimeout(r, 500));
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("worktree（.git 为 gitdir 文件）同样可监听", async () => {
		const main = makeRepo();
		dirs.push(main);
		const wt = join(tmpdir(), `wa-pi-wt-${Math.random().toString(36).slice(2)}`);
		git(["worktree", "add", "-b", "wt-branch", wt], main);
		dirs.push(wt);
		const broadcast = mock(() => {});

		ensureGitWatch("p3", wt, broadcast);
		// 在 worktree 里再切一个新分支 → 其 gitdir 的 HEAD 变化
		git(["checkout", "-b", "wt-branch-2"], wt);

		await waitBroadcast(broadcast);
		expect(broadcast).toHaveBeenCalledWith({
			type: "git:changed",
			projectId: "p3",
		});
	});

	it("重复 ensureGitWatch 同项目不重复监听（广播不翻倍）", async () => {
		const repo = makeRepo();
		dirs.push(repo);
		git(["branch", "outside"], repo);
		const broadcast = mock(() => {});

		ensureGitWatch("p4", repo, broadcast);
		ensureGitWatch("p4", repo, broadcast);
		git(["checkout", "outside"], repo);

		await waitBroadcast(broadcast);
		// 防抖窗口结束后只应有一次有效广播
		await new Promise((r) => setTimeout(r, 800));
		expect(broadcast.mock.calls.length).toBe(1);
	});
});
