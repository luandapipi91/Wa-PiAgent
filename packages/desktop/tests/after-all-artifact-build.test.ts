// after-all-artifact-build.test.ts — ditto 重打包后 blockmap 重新生成。
//
// 背景：f0a68dc4 引入 ditto 重打包（修复 macOS zip 丢失 framework 符号链接）后，
// electron-builder 生成的 blockmap 与重打包后的 zip 内容不一致，增量更新会失败。
// 原实现尝试用 `npx electron-builder --mac --dir` 重新生成 blockmap——该命令只产出
// .app 目录、不产出 zip 的 blockmap，导致 blockmap 实际缺失 → macOS 增量更新退化为
// 全量下载。修复：用 app-builder-lib 的 buildBlockMap（纯 JS Rabin 分块）对重打包
// 后的 zip 重新生成 blockmap。
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const {
	regenerateBlockmap,
} = require("../scripts/after-all-artifact-build.cjs");

test("regenerateBlockmap 对 zip 生成有效 blockmap（gzip JSON，含 Rabin checksums）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "blockmap-test-"));
	try {
		// 构造一个小 zip（模拟真实产物）——跨平台：macOS 用 ditto（保留符号链接语义），
		// 其他平台用 PowerShell Compress-Archive（Windows 自带，无外部依赖）。
		const payloadDir = join(dir, "payload");
		mkdirSync(payloadDir, { recursive: true });
		writeFileSync(join(payloadDir, "a.txt"), "hello ".repeat(4000)); // ~24KB
		const zipPath = join(dir, "test.zip");
		if (process.platform === "darwin") {
			execFileSync("ditto", ["-c", "-k", "--keepParent", payloadDir, zipPath]);
		} else {
			execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-Command",
					`Compress-Archive -Path '${payloadDir}' -DestinationPath '${zipPath}'`,
				],
				{ stdio: "pipe" },
			);
		}

		const blockmapPath = zipPath + ".blockmap";
		await regenerateBlockmap(zipPath, blockmapPath);

		expect(existsSync(blockmapPath)).toBe(true);
		const buf = readFileSync(blockmapPath);
		expect(buf.length).toBeGreaterThan(0);
		// blockmap 是 gzip 压缩的 JSON：version + files[0].checksums（Rabin 分块摘要）
		const parsed = JSON.parse(gunzipSync(buf).toString("utf8"));
		expect(parsed.version).toBeDefined();
		expect(Array.isArray(parsed.files)).toBe(true);
		expect(parsed.files[0].checksums.length).toBeGreaterThan(0);
		expect(parsed.files[0].sizes.length).toBeGreaterThan(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

// ─── Windows 分支：产物签名校验 + 清单哈希一致性 ────────────────────────────────
const { describe, beforeEach, afterEach } = require("bun:test");
const winSign = require("../scripts/win-sign.cjs");
const afterAllArtifactBuild = require("../scripts/after-all-artifact-build.cjs");
const originalVerifyWindowsArtifacts = winSign.verifyWindowsArtifacts;
const originalCheckWinYmlHash = winSign.checkWinYmlHash;

/** 真实 BuildResult 形状：只有 outDir/artifactPaths/platformToTargets/configuration
 *  （没有 electronPlatformName、没有 packager —— 那是 afterPack 的 PackContext）。 */
function makeWinArtifactContext(artifactPaths: string[]) {
	return {
		outDir: "/fake/release",
		artifactPaths,
		platformToTargets: new Map(),
		configuration: { productName: "WA PI Agent" },
	};
}

describe("afterAllArtifactBuild（Windows 签名校验）", () => {
	beforeEach(() => {
		winSign.verifyWindowsArtifacts = originalVerifyWindowsArtifacts;
		winSign.checkWinYmlHash = originalCheckWinYmlHash;
		delete process.env.WA_PI_SKIP_WIN_SIGN;
	});
	afterEach(() => {
		winSign.verifyWindowsArtifacts = originalVerifyWindowsArtifacts;
		winSign.checkWinYmlHash = originalCheckWinYmlHash;
		delete process.env.WA_PI_SKIP_WIN_SIGN;
	});

	test("有未签名产物 → 抛错终止（坏包不许流入 release/）", async () => {
		winSign.verifyWindowsArtifacts = () => {
			throw new Error("[win-sign] 没有有效签名");
		};
		// 让清单相关逻辑不参与本用例
		winSign.checkWinYmlHash = () => ({ ok: true, skipped: true });
		await expect(
			afterAllArtifactBuild.default(makeWinArtifactContext(["/fake/setup.exe"])),
		).rejects.toThrow(/没有有效签名/);
	});

	test("全部通过 → 返回空数组，不干扰产物列表", async () => {
		winSign.verifyWindowsArtifacts = () => [{ file: "/fake/setup.exe", signed: true }];
		winSign.syncWinYmlHash = () => ({ fixed: false, skipped: false });
		winSign.checkWinYmlHash = () => ({ ok: true });
		const r = await afterAllArtifactBuild.default(
			makeWinArtifactContext(["/fake/release/setup.exe"]),
		);
		expect(r).toEqual([]);
	});

	test("WA_PI_SKIP_WIN_SIGN=1 → 跳过校验（本地测试包）", async () => {
		let called = false;
		winSign.verifyWindowsArtifacts = () => {
			called = true;
			return [];
		};
		process.env.WA_PI_SKIP_WIN_SIGN = "1";
		const r = await afterAllArtifactBuild.default(
			makeWinArtifactContext(["/fake/release/setup.exe"]),
		);
		expect(r).toEqual([]);
		expect(called).toBe(false);
	});
});

describe("afterAllArtifactBuild（平台判定）", () => {
	test("产物含 .exe → 判定为 Windows 构建并校验（不依赖不存在的 electronPlatformName）", async () => {
		let called = 0;
		winSign.verifyWindowsArtifacts = () => {
			called += 1;
			return [{ file: "/fake/release/setup.exe", signed: true }];
		};
		winSign.checkWinYmlHash = () => ({ ok: true, skipped: true });
		await afterAllArtifactBuild.default(
			makeWinArtifactContext(["/fake/release/setup.exe"]),
		);
		expect(called).toBe(1);
	});

	test("mac 产物（.dmg/.zip）→ 不当成 Windows 校验", async () => {
		let called = 0;
		winSign.verifyWindowsArtifacts = () => {
			called += 1;
			return [];
		};
		const r = await afterAllArtifactBuild.default({
			outDir: "/fake/release",
			artifactPaths: ["/fake/release/a.dmg", "/fake/release/a.zip"],
			platformToTargets: new Map(),
			configuration: { productName: "WA PI Agent" },
		});
		expect(r).toEqual([]);
		expect(called).toBe(0);
	});

	test("ipa：主程序名取自 configuration.productName（BuildResult 没有 packager）", async () => {
		let seen: any;
		winSign.verifyWindowsArtifacts = (opts: any) => {
			seen = opts;
			return [{ file: "/fake/release/setup.exe", signed: true }];
		};
		winSign.checkWinYmlHash = () => ({ ok: true, skipped: true });
		await afterAllArtifactBuild.default(
			makeWinArtifactContext(["/fake/release/setup.exe"]),
		);
		expect(seen.productFilename).toBe("WA PI Agent");
		expect(seen.appOutDir).toBe("/fake/release/win-unpacked");
	});
});
