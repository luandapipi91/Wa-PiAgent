/**
 * Windows 上 bash 可用性探测。
 *
 * 为什么需要它：Windows 的默认命令工具曾是 powershell（系统自带、零外部依赖），
 * 但装了 Git Bash / Cygwin / MSYS2 / WSL 的机器上 bash 体验更好（与 macOS/Linux
 * 一致、模型输出的 shell 脚本可直接复用）。故启动时探测一次：有 bash 就默认 bash，
 * 没有才回退 powershell。
 *
 * 探测顺序**必须与 pi 引擎一致**（pi-coding-agent `dist/utils/shell.js` 的
 * `getBashShellConfig`）：先 Git Bash 已知安装目录、再 PATH。两处口径不同会出现
 * 「我们判定有 bash → 默认激活 bash 工具 → 引擎执行时找不到 bash 报错」的错位。
 */
import { existsSync } from "node:fs";

export interface BashProbeOptions {
	/** 目标平台（默认 process.platform；测试注入） */
	platform?: string;
	/** PATH 探测：命中返回可执行路径，否则 null（默认 Bun.which；测试注入） */
	which?: (cmd: string) => string | null;
	/** 固定路径存在性（默认 existsSync；测试注入） */
	pathExists?: (path: string) => boolean;
	/** 环境变量（默认 process.env；测试注入） */
	env?: Record<string, string | undefined>;
}

/** 默认 PATH 探测：Bun.which 缺失或抛错时按「未找到」处理，探测本身永不抛出。 */
function defaultWhich(cmd: string): string | null {
	const which = (globalThis as { Bun?: { which?: (c: string) => string | null } })
		.Bun?.which;
	if (typeof which !== "function") return null;
	try {
		return which(cmd) ?? null;
	} catch {
		return null;
	}
}

/**
 * 返回 bash 可执行路径；不可用返回 null。
 *
 * 非 win32 一律返回 "bash"：POSIX 系统必然带 shell，探测无意义。
 * Windows 路径用反斜杠硬拼（不用 path.join）：目标平台是 Windows，
 * 且与 pi 引擎的拼接方式保持一致。
 */
export function detectBash(opts: BashProbeOptions = {}): string | null {
	const platform = opts.platform ?? process.platform;
	if (platform !== "win32") return "bash";

	const env = opts.env ?? process.env;
	const pathExists = opts.pathExists ?? existsSync;
	const which = opts.which ?? defaultWhich;

	// 1. Git Bash 已知安装目录（安装器默认位置；这些目录未必在 PATH 上）
	for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
		if (!root) continue;
		const p = `${root}\\Git\\bin\\bash.exe`;
		if (pathExists(p)) return p;
	}

	// 2. PATH 上的 bash.exe（Cygwin / MSYS2 / WSL 等）
	return which("bash.exe");
}

let cachedAvailable: boolean | null = null;

/**
 * bash 是否可用（默认路径带进程级缓存：探测在 Windows 上要 spawn `where`，
 * 不必每次启动 agent 都查一遍；装了 Git Bash 需重启应用生效）。
 * 显式注入探测依赖时不走缓存，保证可测。
 */
export function isBashAvailable(opts: BashProbeOptions = {}): boolean {
	const injected =
		opts.platform !== undefined ||
		opts.which !== undefined ||
		opts.pathExists !== undefined ||
		opts.env !== undefined;
	if (injected) return detectBash(opts) !== null;
	if (cachedAvailable === null) cachedAvailable = detectBash() !== null;
	return cachedAvailable;
}

/** 仅供测试：清空探测缓存 */
export function resetBashProbeCacheForTest(): void {
	cachedAvailable = null;
}
