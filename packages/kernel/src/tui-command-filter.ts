// tui-command-filter.ts — RPC 模式下 / 菜单的 TUI-only 命令标记
//
// 背景：pi RPC 模式不支持 ctx.ui.custom()（交互式 TUI 面板）。扩展在命令
// handler 里调用它时，pi 侧补丁会让其同步抛错（兜底防挂死），但更好的体验是
// 这类命令不在 / 菜单里展示。
//
// 识别策略：静态预扫描。pi 的 get_commands 为每条 extension 命令返回 sourceInfo
// （扩展入口路径 + baseDir）。扫描该扩展包内的源码文件，命中 ui.custom( 调用
// 即判定整个扩展为 TUI-only，其贡献的命令附加 tuiOnly 标记（前端据此隐藏）。
//
// 取舍：按扩展粒度而非命令粒度。handler 常把 ui.custom 藏在同包辅助函数里
// （如 pi-mcp-adapter 的 handler 调用另一个文件里的 openMcpAuthPanel），精确到
// 命令需要调用图分析，不可靠；代价是同扩展的非 TUI 命令也会被一并标记。

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { CommandInfo } from "@wa-pi/shared";

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

/**
 * TUI-only API 调用特征：ctx.ui.custom( / ui.input( / ui.select( / ui.confirm( / ui.editor(（含泛型形式）。
 * 这些都是对话类 TUI API——在 RPC 模式（wa-pi GUI）下宿主不实现交互面板，扩展 handler 调它们
 * 只会被静默取消（cancelled）→ 命令被消费但无产出，前端表现为“发送后无响应”。
 * 识别并标记这类扩展贡献的命令（tuiOnly: true）。被关闭的命令名由 agent-manager
 * 在拉取命令时登记进 disabledCommandNames，kernel 发送时降级为普通文本（加前导空格）。
 */
const TUI_ONLY_PATTERN = /\bui\.(?:custom|input|select|confirm|editor)(?:\s*<[^>]*>)?\s*\(/;

/** 扫描上限：防止异常巨大的包拖慢菜单加载 */
const MAX_FILES = 300;
const MAX_BYTES = 5 * 1024 * 1024;

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

/**
 * 从扩展入口路径读取包根 package.json 的 name 字段（裸包名，waPiCommandToggles key）。
 * 找不到 package.json / name 缺失 / 读失败时静默返回 undefined（与 isTuiOnlyExtension 同风格，不抛错）。
 */
function resolvePackageName(entryPath: string): string | undefined {
	try {
		const pkg = JSON.parse(
			readFileSync(join(findPackageRoot(entryPath), "package.json"), "utf-8"),
		) as { name?: unknown };
		if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
	} catch {}
	return undefined;
}

/** 判定扩展包是否使用 TUI-only API（ui.custom / ui.input / ui.select / ui.confirm / ui.editor） */
export function isTuiOnlyExtension(
	entryPath: string,
	baseDir?: string,
): boolean {
	const root = baseDir ?? findPackageRoot(entryPath);

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
	return result;
}

/** 给命令附加 TUI-only 标记与包名（packageName，供 ws-server 开关合并）；全量返回 */
export function filterTuiCommands(commands: RawCommandInfo[]): CommandInfo[] {
	return commands.map((cmd) => {
		if (cmd.source !== "extension") return cmd;
		const info = cmd.sourceInfo;
		if (!info?.path) return cmd;
		const tuiOnly = isTuiOnlyExtension(info.path, info.baseDir);
		const packageName = resolvePackageName(info.path);
		const out: CommandInfo = { ...cmd, tuiOnly };
		if (packageName !== undefined) out.packageName = packageName;
		return out;
	});
}

// 被关闭的扩展命令名集合：prompt 路径据此把这类命令降级为普通文本
// （发送给 pi 前加前导空格，绕过 pi 的 / 命令分发），使其像未知命令一样进入大模型。
const disabledCommandNames = new Set<string>();

/** 判定命令名是否已关闭（依赖 getCommands 至少拉取过一次） */
export function isCommandDisabled(name: string): boolean {
	return disabledCommandNames.has(name);
}

/**
 * 登记一批关闭的扩展命令名（toggle 后由 agent-manager 在拉取命令时填充）。
 * 仅登记扩展命令（无 packageName 的 prompt/builtin 命令不受开关控制，不登记）。
 */
export function registerDisabledCommands(names: Iterable<string>): void {
	for (const n of names) disabledCommandNames.add(n);
}

/** 清空降级集合（toggle 命令开关后调用，下次拉取重新填充） */
export function resetDisabledCommands(): void {
	disabledCommandNames.clear();
}
