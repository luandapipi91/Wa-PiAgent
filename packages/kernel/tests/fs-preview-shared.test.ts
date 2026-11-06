/**
 * 预览判定「单一实现」契约（重构锁）。
 *
 * 背景：checkPreviewable / 5MB 预览上限 / 8KB NUL 嗅探阈值曾在 ws-server.ts
 * （fs:readFile 事件）与 routes/fs.ts（POST /api/fs/read-file）各存一份逐字拷贝，
 * 靠注释「保持同步」维护——一侧改了另一侧忘改，WS 与 REST 两条入口的预览行为
 * 就会分叉。本文件锁定：实现只有 fs-preview.ts 一份，两个入口都 import 它。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BINARY_SNIFF_BYTES,
	MAX_PREVIEW_BYTES,
	checkPreviewable,
	getMimeType,
	looksBinary,
} from "../src/fs-preview";

const SRC_DIR = join(import.meta.dir, "..", "src");

describe("fs-preview 共享实现", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "wa-pi-fs-preview-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("导出判定函数与阈值常量（数值只有这一份）", () => {
		expect(MAX_PREVIEW_BYTES).toBe(5 * 1024 * 1024);
		expect(BINARY_SNIFF_BYTES).toBe(8000);
		expect(typeof checkPreviewable).toBe("function");
		expect(typeof looksBinary).toBe("function");
		expect(typeof getMimeType).toBe("function");
	});

	it("checkPreviewable 对文本/二进制/超限的判定语义不变", async () => {
		writeFileSync(join(root, "ok.txt"), "hello");
		expect(await checkPreviewable(join(root, "ok.txt"))).toEqual({ ok: true });

		// 头部含 NUL 的真二进制：即使扩展名未识别也拒绝
		writeFileSync(join(root, "bin"), Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
		const bin = await checkPreviewable(join(root, "bin"));
		expect(bin.ok).toBe(false);
		expect(bin.ok ? "" : bin.code).toBe("attachment.unsupportedType");

		// 超过 5MB 上限拒绝，错误码与阈值参数来自同一常量
		writeFileSync(join(root, "big.txt"), Buffer.alloc(MAX_PREVIEW_BYTES + 1));
		const big = await checkPreviewable(join(root, "big.txt"));
		expect(big.ok ? "" : big.code).toBe("attachment.previewTooLarge");
		expect(big.ok ? {} : big.params).toMatchObject({
			maxMb: MAX_PREVIEW_BYTES / 1024 / 1024,
		});
	});

	it("两条入口都不再保留本地拷贝，且都从 fs-preview 引入", () => {
		const wsSrc = readFileSync(join(SRC_DIR, "ws-server.ts"), "utf8");
		const fsSrc = readFileSync(join(SRC_DIR, "routes", "fs.ts"), "utf8");

		// 正向：两个入口都从共享模块引入
		expect(wsSrc).toContain('from "./fs-preview"');
		expect(fsSrc).toContain('from "../fs-preview"');

		// 反向：任何一侧再长出第二份实现（常量/嗅探/mime 表/判定函数）都算回归
		for (const [name, src] of [
			["ws-server.ts", wsSrc],
			["routes/fs.ts", fsSrc],
		] as const) {
			expect(`${name}:${/const MAX_PREVIEW_BYTES\b/.test(src)}`).toBe(
				`${name}:false`,
			);
			expect(`${name}:${/const BINARY_SNIFF_BYTES\b/.test(src)}`).toBe(
				`${name}:false`,
			);
			expect(`${name}:${/function looksBinary\b/.test(src)}`).toBe(
				`${name}:false`,
			);
			expect(`${name}:${/function checkPreviewable\b/.test(src)}`).toBe(
				`${name}:false`,
			);
			expect(`${name}:${/function getMimeType\b/.test(src)}`).toBe(
				`${name}:false`,
			);
		}
	});
});
