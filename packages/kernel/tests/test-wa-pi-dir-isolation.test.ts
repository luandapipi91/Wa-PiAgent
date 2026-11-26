// 隔离 WA_PI_DIR 的**接线**验证：preload（tests/setup.ts）到底把目录做成了什么样。
//
// 与 test-temp-dir.test.ts 的分工：那边测 helper 的纯行为，这边测「setup.ts 真的接上了」
// ——helper 写对但忘了在 preload 里调用时，本文件必须变红。
//
// 为什么要求 models/bin 是符号链接：每个 worker 进程都会新建一个隔离 WA_PI_DIR，
// 若 models 是真实目录，语义检索类测试就会在各自目录里重复下载 bge-base-zh-v1.5
// （≈98MB × 目录数）；链接到进程外共享根后只落盘/下载一次。
import { describe, expect, test } from "bun:test";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHARED_ASSETS_DIR } from "./helpers/test-temp-dir";

const waPiDir = process.env.WA_PI_DIR!;

/** 把真实路径与符号链接路径都归一，判断前者是否落在共享根内 */
function underSharedRoot(path: string): boolean {
	try {
		return realpathSync(path).startsWith(realpathSync(SHARED_ASSETS_DIR));
	} catch {
		return false;
	}
}

describe("preload 建立的隔离 WA_PI_DIR", () => {
	test("WA_PI_DIR 指向隔离目录（不是正式的 ~/.pi/agent）", () => {
		expect(waPiDir).toBeTruthy();
		expect(waPiDir).not.toContain(".pi/agent");
		expect(statSync(waPiDir).isDirectory()).toBe(true);
	});

	test("models 是指向共享根的符号链接（避免每目录重复下载模型）", () => {
		const models = join(waPiDir, "models");
		expect(lstatSync(models).isSymbolicLink()).toBe(true);
		expect(underSharedRoot(models)).toBe(true);
	});

	test("bin/rg 与 bin/fd 是指向共享根的符号链接，且仍满足「体积达标即已存在」", () => {
		for (const name of ["rg", "fd"]) {
			const p = join(waPiDir, "bin", name);
			expect(lstatSync(p).isSymbolicLink()).toBe(true);
			expect(underSharedRoot(p)).toBe(true);
			// tool-binaries 用 statSync（跟随链接）判体积，链接后必须仍达标
			expect(statSync(p).size).toBeGreaterThanOrEqual(1_000_000);
		}
	});

	test("sessions / tmp / agents / skills 是真实目录（测试要往里写，不能是链接）", () => {
		for (const sub of ["sessions", "tmp/sysprompts", "agents", "skills"]) {
			const p = join(waPiDir, sub);
			expect(lstatSync(p).isSymbolicLink()).toBe(false);
			expect(statSync(p).isDirectory()).toBe(true);
		}
	});
});
