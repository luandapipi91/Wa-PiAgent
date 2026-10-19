/**
 * git 仓库变更监听：外部（终端/其他工具）切换分支、提交等改动 .git 内部文件时，
 * 广播 git:changed 让前端动态刷新分支显示。
 *
 * 监听目标：gitdir 下的 HEAD（切换分支）、refs/ 递归（提交/建删分支）、packed-refs。
 * 按 projectId 去重，事件 300ms 防抖（一次 git 操作会触碰多个文件）。
 */
import {
	watch,
	existsSync,
	statSync,
	readFileSync,
	type FSWatcher,
} from "node:fs";
import { join, resolve } from "node:path";
import type { WSServerEvent } from "@wa-pi/shared";

interface WatchEntry {
	watchers: FSWatcher[];
	timer: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, WatchEntry>();

/**
 * 解析仓库的 gitdir：普通仓库是 `<cwd>/.git` 目录；
 * worktree/submodule 的 `.git` 是文本文件（内容为 `gitdir: <真实路径>`）。
 * 非 git 目录返回 null。
 */
function resolveGitDir(cwd: string): string | null {
	const dotGit = join(cwd, ".git");
	try {
		if (!existsSync(dotGit)) return null;
		if (statSync(dotGit).isDirectory()) return dotGit;
		const content = readFileSync(dotGit, "utf-8").trim();
		const m = content.match(/^gitdir:\s*(.+)$/);
		if (m) return resolve(cwd, m[1].trim());
	} catch {
		// 读不到就当非仓库
	}
	return null;
}

/**
 * 确保项目仓库处于监听中（幂等：同 projectId 重复调用不重复挂监听）。
 * 非 git 目录静默忽略。broadcast 通常为 ws-server 的 SSE 广播。
 */
export function ensureGitWatch(
	projectId: string,
	cwd: string,
	broadcast: (e: WSServerEvent) => void,
): void {
	if (watches.has(projectId)) return;
	const gitDir = resolveGitDir(cwd);
	if (!gitDir) return;

	const entry: WatchEntry = { watchers: [], timer: null };
	const fire = () => {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(
			() => broadcast({ type: "git:changed", projectId }),
			300,
		);
	};
	const tryWatch = (target: string, recursive = false): boolean => {
		try {
			const w = watch(target, { recursive }, fire);
			// 目录被删/权限等错误静默（watcher 失效不影响主流程）
			w.on("error", () => {});
			entry.watchers.push(w);
			return true;
		} catch {
			return false; // 目标不存在（如尚无 packed-refs）等平台差异，忽略
		}
	};

	tryWatch(join(gitDir, "HEAD"));
	tryWatch(join(gitDir, "packed-refs"));
	const refs = join(gitDir, "refs");
	if (existsSync(refs)) {
		// recursive 仅 Windows/macOS 支持，失败回退非递归
		if (!tryWatch(refs, true)) tryWatch(refs);
	}

	if (entry.watchers.length === 0) return;
	watches.set(projectId, entry);
}

/** 关闭全部监听（kernel 关闭/测试清理用） */
export function stopAllGitWatchers(): void {
	for (const entry of watches.values()) {
		if (entry.timer) clearTimeout(entry.timer);
		for (const w of entry.watchers) {
			try {
				w.close();
			} catch {
				// 已关闭的忽略
			}
		}
	}
	watches.clear();
}
