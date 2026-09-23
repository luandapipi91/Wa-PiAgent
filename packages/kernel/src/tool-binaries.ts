// tool-binaries.ts — 预置 pi 内置工具（grep→rg、find→fd）所需的外部二进制
//
// 背景：wa-pi 恒以 --offline spawn pi（见 rpc-client.buildPiArgs）。pi 的
// ensureTool 在 PI_OFFLINE 下跳过下载，而内置 grep/find 依赖外部 rg/fd，
// 于是必然报 "ripgrep (rg) is not available and could not be downloaded"。
// pi 的 getToolPath 先查 PI_CODING_AGENT_DIR/bin（= WA_PI_DIR/bin）且该检查早于
// 离线门控——把二进制预置到位，即可在不放开 --offline 的前提下恢复这两个工具。
//
// 下载走 Bun fetch，经 applySystemProxy 写入 process.env 的 HTTP_PROXY（kernel
// 本地中继）出网；单个工具失败不影响其他工具，失败静默记录、下次启动重试。
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

export type ToolName = "rg" | "fd";

/** 已落地二进制的最小体积，用于判断是否为半截下载/占位文件 */
export const MIN_BINARY_BYTES = 1_000_000;
/** 压缩包的最小体积（fd 的 tar.gz 仅数百 KB） */
const MIN_ARCHIVE_BYTES = 64_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 资产来源，与 pi tools-manager 的 TOOLS 表对齐；版本固定以便复现 */
const TOOL_SPECS: Record<ToolName, { version: string; repo: string; tagPrefix: string }> = {
	rg: { version: "15.2.0", repo: "BurntSushi/ripgrep", tagPrefix: "" },
	fd: { version: "10.3.0", repo: "sharkdp/fd", tagPrefix: "v" },
};

const TOOL_NAMES: ToolName[] = ["rg", "fd"];

export interface ToolAsset {
	tool: ToolName;
	version: string;
	asset: string;
	downloadUrl: string;
	binaryName: string;
}

/** arm64 → aarch64，其余按 x86_64（与上游发布命名一致） */
function archToken(arch: string): string {
	return arch === "arm64" ? "aarch64" : "x86_64";
}

export function toolAssetForPlatform(
	tool: ToolName,
	platform: string,
	arch: string,
): ToolAsset | null {
	const spec = TOOL_SPECS[tool];
	if (!spec) return null;

	const target =
		platform === "darwin"
			? "apple-darwin"
			: platform === "linux"
				? "unknown-linux-musl"
				: platform === "win32"
					? "pc-windows-msvc"
					: null;
	if (!target) return null;

	const prefix = tool === "rg" ? `ripgrep-${spec.version}` : `fd-v${spec.version}`;
	const extension = platform === "win32" ? "zip" : "tar.gz";
	const asset = `${prefix}-${archToken(arch)}-${target}.${extension}`;

	return {
		tool,
		version: spec.version,
		asset,
		downloadUrl: `https://github.com/${spec.repo}/releases/download/${spec.tagPrefix}${spec.version}/${asset}`,
		binaryName: platform === "win32" ? `${tool}.exe` : tool,
	};
}

function isUsableBinary(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).size >= MIN_BINARY_BYTES;
	} catch {
		return false;
	}
}

function runCommand(command: string, args: string[]): void {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (result.error || result.status !== 0) {
		const detail =
			result.error?.message ??
			result.stderr?.toString().trim() ??
			`exit status ${result.status ?? "unknown"}`;
		throw new Error(`${command} 执行失败: ${detail}`);
	}
}

/** 解压默认实现：tar.gz 用系统 tar；zip 优先 Windows 自带 bsdtar */
export function defaultExtract(archivePath: string, destDir: string, assetName: string): void {
	if (assetName.endsWith(".tar.gz")) {
		runCommand("tar", ["xzf", archivePath, "-C", destDir]);
		return;
	}
	if (assetName.endsWith(".zip")) {
		const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		if (process.platform === "win32" && existsSync(systemTar)) {
			runCommand(systemTar, ["xf", archivePath, "-C", destDir]);
			return;
		}
		runCommand("tar", ["xf", archivePath, "-C", destDir]);
		return;
	}
	throw new Error(`不支持的压缩格式: ${assetName}`);
}

function findBinary(rootDir: string, binaryName: string): string | null {
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isFile() && entry.name === binaryName) return full;
			if (entry.isDirectory()) stack.push(full);
		}
	}
	return null;
}

async function downloadArchive(
	url: string,
	fetchImpl: typeof fetch,
): Promise<string> {
	const response = await fetchImpl(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength < MIN_ARCHIVE_BYTES) {
		throw new Error(`下载内容过小（${bytes.byteLength} 字节）`);
	}
	const suffix = url.endsWith(".zip") ? "zip" : "tar.gz";
	const archivePath = join(
		tmpdir(),
		`wa-pi-tool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`,
	);
	writeFileSync(archivePath, bytes);
	return archivePath;
}

export interface EnsureToolBinariesOptions {
	/** 目标目录，默认 WA_PI_DIR/bin（pi 的 getBinDir） */
	binDir?: string;
	platform?: string;
	arch?: string;
	fetchImpl?: typeof fetch;
	extract?: (archivePath: string, destDir: string, assetName: string) => void;
	log?: (level: "info" | "warn", message: string) => void;
}

export interface EnsureToolBinariesResult {
	installed: ToolName[];
	skipped: ToolName[];
	failed: ToolName[];
}

/**
 * 确保 pi 内置工具所需的 rg/fd 存在于 binDir。已存在（体积达标）则跳过；
 * 单个工具失败不影响其他工具，整体不抛错，交由调用方按需记日志。
 */
export async function ensureToolBinaries(
	options: EnsureToolBinariesOptions = {},
): Promise<EnsureToolBinariesResult> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const binDir = options.binDir ?? join(WA_PI_DIR, "bin");
	const fetchImpl = options.fetchImpl ?? fetch;
	const extract = options.extract ?? defaultExtract;
	const log = options.log ?? (() => {});

	const result: EnsureToolBinariesResult = { installed: [], skipped: [], failed: [] };

	for (const tool of TOOL_NAMES) {
		const asset = toolAssetForPlatform(tool, platform, arch);
		if (!asset) {
			result.skipped.push(tool);
			continue;
		}

		const targetPath = join(binDir, asset.binaryName);
		if (isUsableBinary(targetPath)) {
			result.skipped.push(tool);
			continue;
		}

		let archivePath: string | null = null;
		let extractDir: string | null = null;
		try {
			archivePath = await downloadArchive(asset.downloadUrl, fetchImpl);
			extractDir = mkdtempSync(join(tmpdir(), `wa-pi-${tool}-extract-`));
			extract(archivePath, extractDir, asset.asset);

			const extracted = findBinary(extractDir, asset.binaryName);
			if (!extracted) {
				throw new Error(`压缩包内未找到 ${asset.binaryName}`);
			}
			mkdirSync(binDir, { recursive: true });
			copyFileSync(extracted, targetPath);
			if (platform !== "win32") chmodSync(targetPath, 0o755);

			result.installed.push(tool);
			log("info", `已预置 ${tool} → ${targetPath}`);
		} catch (error) {
			result.failed.push(tool);
			log(
				"warn",
				`预置 ${tool} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (extractDir) rmSync(extractDir, { recursive: true, force: true });
			if (archivePath) rmSync(archivePath, { force: true });
		}
	}

	return result;
}
