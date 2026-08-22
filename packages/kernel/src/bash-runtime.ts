// Windows 无 Git Bash 时自动提供 bash：检测系统 bash → 无则下载 PortableGit 到缓存。
//
// 背景：pi 引擎的 bash 工具（agent 调 shell 命令）在 Windows 上依赖 Git for Windows
// 提供的 bash.exe（标准路径 %ProgramFiles%\Git\bin\bash.exe 或 PATH 上的 bash）。
// 没装 Git 的电脑上 agent 调 shell 工具即报 "No bash shell found"（用户可见英文报错）。
// 本模块像 dev 自动下载 bun（scripts/bun-dev-runtime.ts）一样，把 PortableGit 的
// bash 下载到用户缓存目录并接线（写 settings.json.shellPath，pi 引擎读取生效）。
//
// 坑位记录：
//   - GitHub 直连国内极慢（ETIMEDOUT）→ 主源用 npmmirror 镜像（实测 64MB 秒级），
//     GitHub 仅作回退。
//   - PortableGit 的 .7z.exe 是 7-Zip SFX，`-o<dir> -y` 静默解压，无需目标机装 7-Zip。
//   - 解压后 bash 在 <dir>/bin/bash.exe（PortableGit 的 Git 根目录结构）。
//   - 下载/解压异步不阻塞启动；完成接线后需 pi 会话重建才生效（settings 启动时加载），
//     未完成期间 agent 调 shell 由 sdk-errors 的中文提示兜底。

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** PortableGit 固定版本（与 npmmirror 镜像资产名对应，可升级） */
export const PORTABLE_GIT_VERSION = "2.49.0.windows.1";

/** PortableGit 资产名（npmmirror 目录与 GitHub release 资产一致） */
function portableGitArchiveName(): string {
	return process.arch === "arm64"
		? `PortableGit-${PORTABLE_GIT_VERSION.replace(".windows.1", "")}-arm64.7z.exe`
		: `PortableGit-${PORTABLE_GIT_VERSION.replace(".windows.1", "")}-64-bit.7z.exe`;
}

/** 下载源：npmmirror 主（国内快）+ GitHub 回退 */
export function portableBashDownloadUrls(): string[] {
	const archive = portableGitArchiveName();
	const ver = PORTABLE_GIT_VERSION;
	return [
		`https://registry.npmmirror.com/-/binary/git-for-windows/v${ver}/${archive}`,
		`https://github.com/git-for-windows/git/releases/download/v${ver}/${archive}`,
	];
}

/** PortableGit 缓存目录：env 覆盖 > Windows %LOCALAPPDATA%\wa-pi\bash > ~/.cache/wa-pi/bash */
export function portableBashDir(): string {
	if (process.env.WA_PI_BASH_CACHE_DIR) return process.env.WA_PI_BASH_CACHE_DIR;
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		return join(process.env.LOCALAPPDATA, "wa-pi", "bash");
	}
	return join(homedir(), ".cache", "wa-pi", "bash");
}

/** PortableGit 解压后的 bash 可执行文件路径 */
export function portableBashExe(dir: string = portableBashDir()): string {
	return join(dir, "bin", "bash.exe");
}

/** 粗略判断文件可用：存在且 >1MB（挡半截下载） */
function isUsableFile(p: string): boolean {
	try {
		return statSync(p).size > 1_000_000;
	} catch {
		return false;
	}
}

/** 校验 bash 可执行：存在 + 能跑 --version（PATH 注入 usr/bin——MSYS2 DLL 依赖） */
export function bashVersionOf(exe: string): string | null {
	try {
		const r = spawnSync(exe, ["--version"], {
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
			env: bashSpawnEnv(),
		});
		if (r.status !== 0 || !r.stdout) return null;
		const m = r.stdout.match(/version\s+([\d.]+)/i);
		return m ? m[1] : r.stdout.trim().split(/\r?\n/)[0];
	} catch {
		return null;
	}
}

/**
 * bash 子进程 env：PortableGit 的 bash.exe 是 MSYS2 程序，依赖 usr/bin 下的
 * msys-2.0.dll 等；DLL 搜索顺序（exe 目录 → cwd → 系统目录 → PATH）不覆盖它，
 * 直接 spawn 会失败（status undefined）。把 <portableDir>/usr/bin 前置到 PATH。
 */
export function bashSpawnEnv(extraPath: string = ""): Record<string, string> {
	const paths: string[] = [];
	if (extraPath) paths.push(extraPath);
	const dir = portableBashDir();
	paths.push(join(dir, "usr", "bin"), join(dir, "bin"));
	if (process.env.PATH) paths.push(process.env.PATH);
	return {
		...process.env,
		PATH: paths.join(process.platform === "win32" ? ";" : ":"),
	};
}

/** 检测系统已装 bash（Git for Windows 标准路径 + PATH 上的 bash）；无返回 null */
export function findSystemBash(): string | null {
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86)
			candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const c of candidates) {
			if (existsSync(c) && isUsableFile(c)) return c;
		}
	}
	// PATH 上的 bash（Bun.which 优先，Windows 下也能解析 bash.exe）
	const which = (globalThis as any).Bun?.which;
	if (typeof which === "function") {
		const p = which("bash");
		if (p && existsSync(p)) return p;
	}
	return null;
}

/** 下载 PortableGit 压缩包到缓存目录；成功返回下载文件路径，全失败返回 null */
async function downloadPortableGit(dir: string): Promise<string | null> {
	const archive = portableGitArchiveName();
	const dest = join(dir, archive);
	for (const url of portableBashDownloadUrls()) {
		console.log(`[bash] 下载 PortableGit: ${url}`);
		try {
			const res = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.timeout(300_000),
			});
			if (!res.ok || !res.body) {
				console.warn(`[bash] HTTP ${res.status} ${url}`);
				continue;
			}
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length < 5_000_000) {
				console.warn(`[bash] 下载过小 (${buf.length}B)，丢弃`);
				continue;
			}
			await writeFile(dest, buf);
			return dest;
		} catch (e) {
			console.warn(`[bash] 下载失败 ${url}: ${(e as Error).message}`);
		}
	}
	return null;
}

/** 解压 PortableGit（7-Zip SFX：-o<dir> -y 静默）；bash.exe 就位返回 true */
async function extractPortableGit(sfx: string, dir: string): Promise<boolean> {
	// 解压到缓存目录根：PortableGit 内容（bin/ usr/ etc/）直接平铺，
	// bash 在 <dir>/bin/bash.exe（与 portableBashExe() 一致）。
	mkdirSync(dir, { recursive: true });
	// SFX 在 Windows 下直接 spawn；-o 参数指定输出目录（7z SFX 语义）
	const r = spawnSync(sfx, ["-o" + dir, "-y"], {
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
		stdio: "pipe",
	});
	rmSync(sfx, { force: true });
	if (r.status !== 0) {
		console.warn(
			`[bash] SFX 解压失败 (exit=${r.status}): ${r.stderr?.slice(-200)}`,
		);
		return false;
	}
	const exe = join(dir, "bin", "bash.exe");
	// bash.exe 是 launcher（~47KB，真实 bash 在 usr/bin/bash.exe），
	// 不能用 1MB 大小粗判（会误判为半截下载）——直接执行校验。
	return existsSync(exe) && bashVersionOf(exe) !== null;
}

/**
 * 确保 PortableGit bash 就绪：缓存已有可用 bash → 直接返回；否则下载 + 解压。
 * 返回可用 bash.exe 路径；失败返回 null（调用方回落系统检测/中文提示）。
 */
export async function ensurePortableBash(): Promise<string | null> {
	const dir = portableBashDir();
	const cached = portableBashExe(dir);
	// bash.exe 是 launcher（~47KB），大小粗判会误伤；用真实执行校验
	if (existsSync(cached) && bashVersionOf(cached)) {
		return cached;
	}
	try {
		await mkdir(dir, { recursive: true });
		const sfx = await downloadPortableGit(dir);
		if (!sfx) return null;
		const ok = await extractPortableGit(sfx, dir);
		if (!ok) return null;
		const exe = portableBashExe(dir);
		const v = bashVersionOf(exe);
		if (!v) {
			console.warn(`[bash] PortableGit bash 校验失败`);
			return null;
		}
		// 接线前置：把 usr/bin 注入 kernel 进程 PATH（pi 子进程继承），
		// spawn bash 时能找到 msys-2.0.dll 等依赖。
		const usrBin = join(dir, "usr", "bin");
		const sep = process.platform === "win32" ? ";" : ":";
		if (!process.env.PATH?.split(sep).includes(usrBin)) {
			process.env.PATH = `${usrBin}${sep}${process.env.PATH ?? ""}`;
		}
		console.log(`[bash] PortableGit bash 就绪: ${exe} (${v})`);
		return exe;
	} catch (e) {
		console.warn(`[bash] PortableGit 准备失败: ${(e as Error).message}`);
		return null;
	}
}

/**
 * 保障 bash 可用（接线入口，kernel 启动时调用，不阻塞启动）：
 *   - 非 Windows / 系统已有 bash → 无需接线（返回 null 表示"系统足够"）
 *   - 否则确保 PortableGit 下载解压，返回其 bash 路径（调用方写 settings.json.shellPath）
 */
export async function ensureBashAvailable(): Promise<string | null> {
	if (process.platform !== "win32") return null;
	if (findSystemBash()) {
		console.log("[bash] 系统已装 Git Bash，无需 PortableGit");
		return null;
	}
	const exe = await ensurePortableBash();
	return exe;
}
