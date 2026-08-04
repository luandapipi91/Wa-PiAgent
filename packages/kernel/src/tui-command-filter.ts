// tui-command-filter.ts — extension 命令的包名（packageName）附加
//
// 历史：本文件曾静态扫描扩展源码识别 TUI-only 命令（ui.custom/input/select/...），
// 已删除。理由：pi 官方无 TUI-only 概念——get_commands 不返回内置 TUI 命令；
// RPC 模式 custom() 返回 undefined（扩展应用 ctx.mode === "tui" 自守卫）；
// select/confirm/input/editor 有官方 dialog 子协议（本宿主已对接，见 ext-ui-registry）。
// 且前端自 e9eeae10 起不再消费 tuiOnly 标记，扫描纯属开销 + 误标。

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

/** 给 extension 来源命令附加 packageName（waPiCommandToggles 的 key）；其余原样返回 */
export function attachPackageName(commands: RawCommandInfo[]): CommandInfo[] {
	return commands.map((cmd) => {
		if (cmd.source !== "extension") return cmd;
		const info = cmd.sourceInfo;
		if (!info?.path) return cmd;
		const packageName = resolvePackageName(info.path);
		if (packageName === undefined) return cmd;
		return { ...cmd, packageName };
	});
}
