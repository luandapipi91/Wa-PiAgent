import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CJS mock 手法：require 缓存共享——先拿到 mac-sign.cjs 的导出对象，
// 在每个用例里替换其 signMacApp，再加载 after-pack.cjs（它 require 到同一缓存对象）。
const macSign = require("../scripts/mac-sign.cjs");
const originalSignMacApp = macSign.signMacApp;
const afterPack = require("../scripts/after-pack.cjs");

/** 构造一个「mac 产物目录已存在」的 AfterPackContext 最小桩 */
function makeContextWithApp(): { dir: string; ctx: Record<string, unknown> } {
	const dir = mkdtempSync(join(tmpdir(), "after-pack-test-"));
	mkdirSync(join(dir, "release", "mac", "WA PI Agent.app"), {
		recursive: true,
	});
	return {
		dir,
		ctx: {
			electronPlatformName: "darwin",
			appOutDir: join(dir, "release", "mac"),
			packager: { appInfo: { productFilename: "WA PI Agent" } },
		},
	};
}

const saveEnv = { skip: process.env.WA_PI_SKIP_MAC_SIGN };

describe("after-pack（macOS 签名钩子）", () => {
	beforeEach(() => {
		macSign.signMacApp = originalSignMacApp;
	});
	afterEach(() => {
		macSign.signMacApp = originalSignMacApp;
		if (saveEnv.skip === undefined) delete process.env.WA_PI_SKIP_MAC_SIGN;
		else process.env.WA_PI_SKIP_MAC_SIGN = saveEnv.skip;
	});

	test("签名失败（signed:false）→ 终止打包（throw，禁止产出无签名/坏签名包）", async () => {
		const { dir, ctx } = makeContextWithApp();
		try {
			macSign.signMacApp = () => ({
				signed: false,
				identity: "-",
				error: "no identity",
			});
			await expect(afterPack.default(ctx)).rejects.toThrow(/签名失败|no identity/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("WA_PI_SKIP_MAC_SIGN=1 → 跳过签名不报错（锁定既有行为）", async () => {
		const { dir, ctx } = makeContextWithApp();
		try {
			let called = false;
			macSign.signMacApp = () => {
				called = true;
				return { signed: true, identity: "x" };
			};
			process.env.WA_PI_SKIP_MAC_SIGN = "1";
			await afterPack.default(ctx);
			expect(called).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("签名成功 → 不抛错（锁定既有行为）", async () => {
		const { dir, ctx } = makeContextWithApp();
		try {
			macSign.signMacApp = () => ({
				signed: true,
				identity: "WA PI Agent Self-Signed",
			});
			await expect(afterPack.default(ctx)).resolves.toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
