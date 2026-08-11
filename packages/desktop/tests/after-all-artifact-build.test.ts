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

const { regenerateBlockmap } = require("../scripts/after-all-artifact-build.cjs");

test("regenerateBlockmap 对 zip 生成有效 blockmap（gzip JSON，含 Rabin checksums）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "blockmap-test-"));
	try {
		// 构造一个小 zip（macOS ditto，模拟真实产物），内容跨多个 Rabin 块
		const payloadDir = join(dir, "payload");
		mkdirSync(payloadDir, { recursive: true });
		writeFileSync(join(payloadDir, "a.txt"), "hello ".repeat(4000)); // ~24KB
		const zipPath = join(dir, "test.zip");
		execFileSync("ditto", ["-c", "-k", "--keepParent", payloadDir, zipPath]);

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
