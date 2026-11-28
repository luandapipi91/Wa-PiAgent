// main.cjs 对「启动更新检查」的接线断言（main.cjs 依赖 electron 无法直接实例化，
// 按仓库既有范式做源码断言，同 window-state-wiring.test.ts）：
// 1) setupUpdater 的返回值必须接住（startupCheck 由主进程持有）
// 2) revealMainWindow 必须调用 startupCheck.retryNow()——主窗口打开那一刻，若启动检查
//    因网络/系统代理未就绪而失败，立即补查一次，让「新版本」卡片随主窗口出现
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "main.cjs"), "utf8");

test("main.cjs：接住 setupUpdater 返回的 startupCheck", () => {
	// 调用处必须是赋值（模块级 let startupCheck 在 whenReady 内被赋值）
	expect(src).toContain("let startupCheck = null;");
	expect(src).toMatch(/startupCheck = setupUpdater\(\{[\s\S]*?\r?\n\t\}\)\.startupCheck;/);
});

test("main.cjs：revealMainWindow 调用 startupCheck?.retryNow()（显窗即补查失败的启动检查）", () => {
	const i = src.indexOf("function revealMainWindow()");
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, src.indexOf("\n}", i));
	expect(body).toContain("startupCheck?.retryNow()");
});
