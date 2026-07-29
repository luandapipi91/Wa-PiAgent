// tui-command-filter.ts — RPC 模式下 / 菜单的 TUI-only 命令过滤
//
// 背景：pi RPC 模式不支持 ctx.ui.custom()（交互式 TUI 面板）。扩展在命令
// handler 里调用它时，pi 侧补丁会让其同步抛错（兜底防挂死），但更好的体验是
// 这类命令压根不出现在 / 菜单里。
//
// 识别策略：静态预扫描。pi 的 get_commands 为每条 extension 命令返回 sourceInfo
// （扩展入口路径 + baseDir）。扫描该扩展包内的源码文件，命中 ui.custom( 调用
// 即判定整个扩展为 TUI-only，其贡献的命令全部从菜单过滤。
//
// 取舍：按扩展粒度而非命令粒度。handler 常把 ui.custom 藏在同包辅助函数里
// （如 pi-mcp-adapter 的 handler 调用另一个文件里的 openMcpAuthPanel），精确到
// 命令需要调用图分析，不可靠；代价是同扩展的非 TUI 命令也会被一并隐藏。

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { CommandInfo } from "@hiagent/shared";

/** pi get_commands 返回的原始命令条目（比前端 CommandInfo 多 sourceInfo） */
export interface RawCommandInfo extends CommandInfo {
	sourceInfo?: {
		path: string;
		source?: string;
		scope?: string;
		origin?: string;
		baseDir?: string;
	};
}

/** TUI-only API 调用特征：ctx.ui.custom( / ui.custom( */
const TUI_ONLY_PATTERN = /\bui\.custom\s*\(/;

/** 扫描上限：防止异常巨大的包拖慢菜单加载 */
const MAX_FILES = 300;
const MAX_BYTES = 5 * 1024 * 1024;

// 扫描结果缓存：包根 → 是否 TUI-only。已装扩展运行期不会变化；运行时新装的
// 扩展是新路径自然 miss。同路径升级扩展需重启 kernel 后才会重新扫描。
const scanCache = new Map<string, boolean>();

/** 从扩展入口路径向上找包根（含 package.json 的目录），找不到则退化为入口所在目录 */
function findPackageRoot(entryPath: string): string {
	let dir = dirname(entryPath);
	for (let i = 0; i < 10; i++) {
		try {
			if (statSync(join(dir, "package.json")).isFile()) return dir;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirname(entryPath);
}

/** 判定扩展包是否使用 TUI-only API（ui.custom） */
export function isTuiOnlyExtension(entryPath: string, baseDir?: string): boolean {
	const root = baseDir ?? findPackageRoot(entryPath);
	const cached = scanCache.get(root);
	if (cached !== undefined) return cached;

	let result = false;
	let files = 0;
	let bytes = 0;
	const walk = (dir: string): void => {
		if (result || files >= MAX_FILES || bytes >= MAX_BYTES) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (result || files >= MAX_FILES || bytes >= MAX_BYTES) return;
			if (e.name === "node_modules" || e.name.startsWith(".")) continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				walk(p);
				continue;
			}
			const ext = extname(e.name);
			if (ext !== ".ts" && ext !== ".js") continue;
			files++;
			try {
				const content = readFileSync(p, "utf-8");
				bytes += content.length;
				if (TUI_ONLY_PATTERN.test(content)) {
					result = true;
					return;
				}
			} catch {}
		}
	};
	walk(root);
	scanCache.set(root, result);
	return result;
}

/** 过滤掉 TUI-only 扩展贡献的命令；非 extension 来源或无 sourceInfo 的命令原样保留 */
export function filterTuiCommands(commands: RawCommandInfo[]): CommandInfo[] {
	return commands.filter((cmd) => {
		if (cmd.source !== "extension") return true;
		const info = cmd.sourceInfo;
		if (!info?.path) return true;
		if (!isTuiOnlyExtension(info.path, info.baseDir)) return true;
		tuiOnlyCommandNames.add(cmd.name);
		return false;
	});
}

// 被过滤掉的 TUI-only 命令名集合：prompt 路径据此把这类命令降级为普通文本
// （发送给 pi 前加前导空格，绕过 pi 的 / 命令分发），使其像未知命令一样进入大模型。
const tuiOnlyCommandNames = new Set<string>();

/** 判定命令名是否为已识别的 TUI-only 命令（依赖 getCommands 至少拉取过一次） */
export function isTuiOnlyCommand(name: string): boolean {
	return tuiOnlyCommandNames.has(name);
}
