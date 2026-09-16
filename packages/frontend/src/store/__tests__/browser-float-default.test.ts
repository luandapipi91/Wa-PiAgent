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

// 注：「无历史记录 → floatRect 为 null → 渲染期 defaultRect 现算居中并固化」
// 的行为覆盖已迁至 FloatPreview.test.tsx（store 层新语义为无记录返回 null，
// 不再在模块加载期算默认位置），此处不再重复断言，避免跨文件模块缓存下的顺序脆弱性。

test("setFloatRect 同步落盘：调用返回后立即可读（拖完立刻退出应用也不丢位置）", () => {
	useBrowserStore.getState().setFloatRect({ x: 111, y: 222, w: 720, h: 480 });
	// 不等待任何定时器，同步断言（语义比较，不锁 JSON 键序）
	const saved = JSON.parse(
		localStorage.getItem("hiagent.browser.floatRect") ?? "null",
	);
	expect(saved).toEqual({ x: 111, y: 222, w: 720, h: 480 });
});
