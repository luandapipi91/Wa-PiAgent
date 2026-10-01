// tui-command-filter.ts — 命令清单后处理：剔除内置命令 + 附加包名（packageName）
//
// 1. 剔除内置命令：pi 内置扩展（mcp / llama.cpp 等）经 get_commands 返回的命令，
//    其 sourceInfo.path 是合成路径 "builtin:<name>"（非真实文件路径）。这些命令在
//    Wa-Pi 里没有对应 UI（/mcp 在 RPC 下只是一条 notify，Wa-Pi 有独立 MCP 管理页），
//    保留在 / 菜单里只会误导用户。注意它们的 source 仍是 "extension"（不是
//    "builtin"），因此只能按 sourceInfo.path 前缀判断。
// 2. 附加包名：extension 命令按 sourceInfo.path 向上找包根 package.json 的 name，
//    作为 packageName（waPiCommandToggles 的 key）。
//
// 历史：本文件曾静态扫描扩展源码识别 TUI-only 命令（ui.custom/input/select/...），
// 已删除（前端自 e9eeae10 起不再消费 tuiOnly 标记，扫描纯属开销 + 误标）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import type { CommandInfo } from "@wa-pi/shared";

/** pi get_commands 返回的原始命令条目（比前端 CommandInfo 多 sourceInfo） */
export interface RawCommandInfo extends CommandInfo {
	sourceInfo?: { path: string; source?: string; scope?: string; origin?: string; baseDir?: string };
}

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
 * 找不到 package.json / name 缺失 / 读失败时静默返回 undefined（不抛错）。
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

/** 内置扩展命令的合成路径前缀（pi 侧 `builtin:<name>`，见 pi resource-loader） */
const BUILTIN_PATH_PREFIX = "builtin:";

/**
 * 命令清单后处理：剔除内置扩展命令（sourceInfo.path 为 `builtin:`），
 * 并给其余 extension 来源命令附加 packageName（waPiCommandToggles 的 key）。
 * 非 extension 来源（prompt/skill 等）原样返回。
 */
export function attachPackageName(commands: RawCommandInfo[]): CommandInfo[] {
	return commands
		.filter((cmd) => !cmd.sourceInfo?.path?.startsWith(BUILTIN_PATH_PREFIX))
		.map((cmd) => {
			if (cmd.source !== "extension") return cmd;
			const info = cmd.sourceInfo;
			if (!info?.path) return cmd;
			const packageName = resolvePackageName(info.path);
			if (packageName === undefined) return cmd;
			return { ...cmd, packageName };
		});
}
