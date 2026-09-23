// tool-binaries.test.ts — pi 内置工具（grep/find）所需二进制预置逻辑
//
// 背景：wa-pi 恒以 --offline spawn pi，pi 的 ensureTool 在离线时跳过下载，
// 导致内置 grep/find 工具因缺 rg/fd 而报 "is not available and could not be
// downloaded"。pi 的 getToolPath 会先查 PI_CODING_AGENT_DIR/bin（= WA_PI_DIR/bin）
// 且该检查早于离线门控，故 kernel 启动时把 rg/fd 预置到该目录即可解耦。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureToolBinaries,
	toolAssetForPlatform,
	MIN_BINARY_BYTES,
} from "../src/tool-binaries";

const tmpPaths: string[] = [];

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-tool-binaries-"));
	tmpPaths.push(dir);
	return dir;
}

afterEach(() => {
	for (const path of tmpPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("toolAssetForPlatform", () => {
	test("darwin x64 → ripgrep tar.gz，URL 无 v 前缀", () => {
		const asset = toolAssetForPlatform("rg", "darwin", "x64");
		expect(asset).not.toBeNull();
		expect(asset?.asset).toBe("ripgrep-15.2.0-x86_64-apple-darwin.tar.gz");
		expect(asset?.downloadUrl).toBe(
			"https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz",
		);
		expect(asset?.binaryName).toBe("rg");
	});

	test("darwin arm64 → aarch64，fd 的 URL 带 v 前缀", () => {
		const rg = toolAssetForPlatform("rg", "darwin", "arm64");
		expect(rg?.asset).toBe("ripgrep-15.2.0-aarch64-apple-darwin.tar.gz");
		const fd = toolAssetForPlatform("fd", "darwin", "arm64");
		expect(fd?.asset).toBe("fd-v10.3.0-aarch64-apple-darwin.tar.gz");
		expect(fd?.downloadUrl).toBe(
			"https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-aarch64-apple-darwin.tar.gz",
		);
		expect(fd?.binaryName).toBe("fd");
	});

	test("linux x64 → musl 资产", () => {
		expect(toolAssetForPlatform("rg", "linux", "x64")?.asset).toBe(
			"ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
		);
		expect(toolAssetForPlatform("fd", "linux", "x64")?.asset).toBe(
			"fd-v10.3.0-x86_64-unknown-linux-musl.tar.gz",
		);
	});

	test("win32 x64 → zip 资产且二进制名带 .exe", () => {
		const asset = toolAssetForPlatform("rg", "win32", "x64");
		expect(asset?.asset).toBe("ripgrep-15.2.0-x86_64-pc-windows-msvc.zip");
		expect(asset?.binaryName).toBe("rg.exe");
	});

	test("未知平台返回 null", () => {
		expect(toolAssetForPlatform("rg", "sunos", "x64")).toBeNull();
	});
});

describe("ensureToolBinaries", () => {
	test("已有可用二进制时全部跳过且不发起请求", async () => {
		const binDir = join(makeTmpDir(), "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "rg"), Buffer.alloc(MIN_BINARY_BYTES + 1));
		writeFileSync(join(binDir, "fd"), Buffer.alloc(MIN_BINARY_BYTES + 1));
		let fetchCalls = 0;
		const result = await ensureToolBinaries({
			binDir,
			platform: "darwin",
			arch: "x64",
			fetchImpl: (async () => {
				fetchCalls += 1;
				return new Response("");
			}) as unknown as typeof fetch,
		});
		expect(fetchCalls).toBe(0);
		expect([...result.skipped].sort()).toEqual(["fd", "rg"]);
		expect(result.installed).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	test("缺失时下载、解压并落盘为可执行文件", async () => {
		const binDir = join(makeTmpDir(), "bin");
		const fetchedUrls: string[] = [];
		const result = await ensureToolBinaries({
			binDir,
			platform: "darwin",
			arch: "x64",
			fetchImpl: (async (url: string) => {
				fetchedUrls.push(String(url));
				return new Response(new Uint8Array(MIN_BINARY_BYTES + 1), { status: 200 });
			}) as unknown as typeof fetch,
			extract: (_archivePath, destDir, assetBase) => {
				mkdirSync(join(destDir, assetBase), { recursive: true });
				writeFileSync(join(destDir, assetBase, "rg"), Buffer.alloc(MIN_BINARY_BYTES + 1));
				writeFileSync(join(destDir, assetBase, "fd"), Buffer.alloc(MIN_BINARY_BYTES + 1));
			},
		});
		expect([...result.installed].sort()).toEqual(["fd", "rg"]);
		expect(existsSync(join(binDir, "rg"))).toBe(true);
		expect(existsSync(join(binDir, "fd"))).toBe(true);
		expect(statSync(join(binDir, "rg")).mode & 0o111).toBeGreaterThan(0);
		expect(fetchedUrls.length).toBe(2);
		for (const url of fetchedUrls) expect(url).toContain("github.com/");
	});

	test("下载失败时不抛错，记录失败工具", async () => {
		const binDir = join(makeTmpDir(), "bin");
		const result = await ensureToolBinaries({
			binDir,
			platform: "darwin",
			arch: "x64",
			fetchImpl: (async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch,
			extract: () => {},
		});
		expect(result.installed).toEqual([]);
		expect([...result.failed].sort()).toEqual(["fd", "rg"]);
		expect(existsSync(join(binDir, "rg"))).toBe(false);
	});

	test("平台无对应资产时跳过（不下载）", async () => {
		const binDir = join(makeTmpDir(), "bin");
		let fetchCalls = 0;
		const result = await ensureToolBinaries({
			binDir,
			platform: "sunos",
			arch: "x64",
			fetchImpl: (async () => {
				fetchCalls += 1;
				return new Response("");
			}) as unknown as typeof fetch,
		});
		expect(fetchCalls).toBe(0);
		expect([...result.skipped].sort()).toEqual(["fd", "rg"]);
	});
});
