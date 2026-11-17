// MCP stdio 子进程的 cwd 兜底（2026-11-17 Context7 运行时 0 工具的根因修复）。
//
// 背景：
//   pi 运行时的 stdio MCP 子进程 cwd = 会话工作目录（项目目录），而 npx/npm/pnpm 等命令
//   会读取 cwd 的 package.json。项目带 `overrides` 时 npm 直接 `EOVERRIDE` 秒退 —— 进程根本
//   没进入握手阶段，会话里工具数恒为 0，且报错是 stderr 里的 npm 文本，极易被误判成「冷启动超时」。
//   面板探测（mcp-probe.ts 的 stdioCwd）早已用数据目录兜底，会话运行时没有，于是出现
//   「面板连接正常、运行时 0 工具」的分裂。
//
// 解法：
//   对「包管理器命令 + 未显式配置 cwd」的 stdio 条目补数据目录（与 mcp-probe 同源）。
//   只动必然读项目 package.json 的命令；其他 stdio（node server.js、python -m ...）可能刻意
//   依赖会话目录，保持继承语义不动。
//
// 落点：McpFile.save（新写入）+ normalizeMcpStdioCwd（存量配置，启动/受信时幂等补全）。

/** 会读取 cwd 的 package.json / 项目上下文的包管理器命令（按 basename 比较） */
const PACKAGE_MANAGER_COMMANDS = new Set([
	"npx",
	"npm",
	"pnpm",
	"yarn",
	"bunx",
	"corepack",
]);

/** 命令的 basename，去掉 Windows 的 .cmd / .exe / .ps1 / .bat 后缀并转小写 */
function commandName(command: string): string {
	const base = command.split(/[\\/]/).pop() ?? "";
	return base.toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, "");
}

/** 该命令是否是会读取项目 package.json 的包管理器 */
export function isPackageManagerCommand(command: unknown): boolean {
	return (
		typeof command === "string" && PACKAGE_MANAGER_COMMANDS.has(commandName(command))
	);
}

/**
 * 对 MCP server 条目做 cwd 兜底，返回新条目（无需改动时原样返回同一引用，调用方可用
 * `next !== entry` 判断是否发生变化）。
 *
 * 生效条件（全部满足）：
 *   - 是 stdio 条目（有 command、无 url）；
 *   - 未显式配置非空 cwd；
 *   - command 是包管理器命令。
 */
export function withStdioCwdFallback<T extends Record<string, unknown>>(
	entry: T,
	fallbackCwd: string,
): T & { cwd?: string } {
	if (entry.url !== undefined) return entry;
	if (typeof entry.command !== "string") return entry;
	if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") return entry;
	if (!isPackageManagerCommand(entry.command)) return entry;
	return { ...entry, cwd: fallbackCwd };
}
