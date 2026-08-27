// 浮窗位置行为 store 单测：
// 运行时取证结论（2026-08-30）：持久化链路健康，但 ①无历史时默认位是右上角而非居中；
// ②setFloatRect 走 300ms trailing debounce——如今它只在拖动 mouseup 时提交一次，
// 「拖完立刻退出应用」会丢最后一次位置。本文件锁定：默认居中 + 直写落盘。
// 注意：store 单例在首次 import 时按当帧 innerWidth/Height 初始化，
// 因此必须在动态 import 之前固定视口尺寸（--isolate 保证本文件环境干净）。
import { test, expect } from "bun:test";

Object.defineProperty(window, "innerWidth", {
	value: 1280,
	configurable: true,
});
Object.defineProperty(window, "innerHeight", {
	value: 800,
	configurable: true,
});
localStorage.removeItem("hiagent.browser.floatRect");

const { useBrowserStore } = await import("../../store/browser");

test("无历史记录时，浮窗默认弹出位置为视口居中", () => {
	const r = useBrowserStore.getState().floatRect;
	expect(r.w).toBeGreaterThan(0);
	expect(r.h).toBeGreaterThan(0);
	// 水平垂直都应落在视口中线附近（允许 clamp 取整误差 ±1px）
	expect(Math.abs(r.x - (1280 - r.w) / 2)).toBeLessThanOrEqual(1);
	expect(Math.abs(r.y - (800 - r.h) / 2)).toBeLessThanOrEqual(1);
});

test("setFloatRect 同步落盘：调用返回后立即可读（拖完立刻退出应用也不丢位置）", () => {
	useBrowserStore.getState().setFloatRect({ x: 111, y: 222, w: 720, h: 480 });
	// 不等待任何定时器，同步断言（语义比较，不锁 JSON 键序）
	const saved = JSON.parse(
		localStorage.getItem("hiagent.browser.floatRect") ?? "null",
	);
	expect(saved).toEqual({ x: 111, y: 222, w: 720, h: 480 });
});
