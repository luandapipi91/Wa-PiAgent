import { test, expect, beforeEach } from "bun:test";
import {
	useBrowserStore,
	clampRatio,
	clampRect,
	clampDetachedRect,
	defaultBrowserMode,
	resolveMode,
	setPersistDebounceMs,
} from "./browser";

/** 临时装上 Electron 预览窗口桥（happy-dom 环境默认无桥，float 会被降级） */
function withPreviewBridge(fn: () => void): void {
	const w = window as unknown as { waPiPreviewWin?: unknown };
	const prev = w.waPiPreviewWin;
	w.waPiPreviewWin = {
		open: async () => ({ ok: true }),
		cmd: () => {},
		act: () => {},
		setSize: () => {},
		onEvent: () => () => {},
	};
	try {
		fn();
	} finally {
		if (prev === undefined) delete w.waPiPreviewWin;
		else w.waPiPreviewWin = prev;
	}
}

beforeEach(() => {
	// 同步持久化：本文件断言 localStorage 立即写入，关闭防抖保持确定性
	setPersistDebounceMs(0);
	localStorage.clear();
	useBrowserStore.setState({
		open: false,
		path: null,
		sessionId: null,
		mode: "split",
		splitRatio: 0.5,
		floatRect: { x: 100, y: 60, w: 720, h: 480 },
		detachedRect: null,
		minimized: false,
		bubblePos: { x: 500, y: 400 },
		bySession: {},
	});
});

test("默认 split 模式、50/50 比例", () => {
	const s = useBrowserStore.getState();
	expect(s.mode).toBe("split");
	expect(s.splitRatio).toBe(0.5);
});

test("setMode 切换并持久化（有 Electron 桥时 float 仍可用）", () => {
	withPreviewBridge(() => {
		useBrowserStore.getState().setMode("float");
		expect(useBrowserStore.getState().mode).toBe("float");
		expect(localStorage.getItem("hiagent.browser.mode")).toBe("float");
	});
});

test('无 Electron 桥（浏览器）时 setMode("float") 降级为分屏', () => {
	// float 的承载者是 Electron 独立窗口：无桥环境保留 float 会表现为「预览消失
	// 且没有任何 UI 出路」（主窗口不渲染面板），故写侧直接降级、不落盘 float
	useBrowserStore.getState().setMode("float");
	expect(useBrowserStore.getState().mode).toBe("split");
	expect(localStorage.getItem("hiagent.browser.mode")).toBe("split");
});

test("setSplitRatio clamp 到 [0.2, 0.8] 并持久化", () => {
	useBrowserStore.getState().setSplitRatio(0.05);
	expect(useBrowserStore.getState().splitRatio).toBe(0.2);
	useBrowserStore.getState().setSplitRatio(0.95);
	expect(useBrowserStore.getState().splitRatio).toBe(0.8);
	useBrowserStore.getState().setSplitRatio(0.6);
	expect(useBrowserStore.getState().splitRatio).toBe(0.6);
	expect(localStorage.getItem("hiagent.browser.splitRatio")).toBe("0.6");
});

test("clampRatio 边界", () => {
	expect(clampRatio(0)).toBe(0.2);
	expect(clampRatio(1)).toBe(0.8);
	expect(clampRatio(0.5)).toBe(0.5);
});

test("setFloatRect clamp 在视口内并持久化", () => {
	useBrowserStore.getState().setFloatRect({ x: -50, y: 99999, w: 100, h: 100 });
	const r = useBrowserStore.getState().floatRect;
	if (!r) throw new Error("setFloatRect 后 floatRect 不应为 null");
	expect(r.x).toBeGreaterThanOrEqual(0);
	expect(r.y).toBeLessThanOrEqual(window.innerHeight - r.h);
	expect(r.w).toBeGreaterThanOrEqual(320); // 最小宽
	expect(r.h).toBeGreaterThanOrEqual(240); // 最小高
	const saved = JSON.parse(localStorage.getItem("hiagent.browser.floatRect")!);
	expect(saved.x).toBe(r.x);
});

test("clampRect 尺寸不超过视口", () => {
	const r = clampRect({ x: 0, y: 0, w: 99999, h: 99999 });
	expect(r.w).toBeLessThanOrEqual(window.innerWidth);
	expect(r.h).toBeLessThanOrEqual(window.innerHeight);
});

test("openBrowser/closeBrowser 原语义不变", () => {
	useBrowserStore.getState().openBrowser("/a/index.html", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/a/index.html");
	useBrowserStore.getState().closeBrowser();
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().path).toBeNull();
});

test("持久化 trailing debounce：连续写合并为最后一次", async () => {
	setPersistDebounceMs(20);
	useBrowserStore.getState().setSplitRatio(0.4);
	useBrowserStore.getState().setSplitRatio(0.5);
	useBrowserStore.getState().setSplitRatio(0.6);
	// 防抖窗口内不落盘
	expect(localStorage.getItem("hiagent.browser.splitRatio")).toBeNull();
	// store 状态即时生效（不等防抖）
	expect(useBrowserStore.getState().splitRatio).toBe(0.6);
	await new Promise((r) => setTimeout(r, 60));
	expect(localStorage.getItem("hiagent.browser.splitRatio")).toBe("0.6");
	setPersistDebounceMs(0);
});

test("setMinimized 切换；openBrowser/closeBrowser 重置为 false", () => {
	expect(useBrowserStore.getState().minimized).toBe(false);
	useBrowserStore.getState().setMinimized(true);
	expect(useBrowserStore.getState().minimized).toBe(true);
	useBrowserStore.getState().openBrowser("/a/index.html", "s1");
	expect(useBrowserStore.getState().minimized).toBe(false);
	useBrowserStore.getState().setMinimized(true);
	useBrowserStore.getState().closeBrowser();
	expect(useBrowserStore.getState().minimized).toBe(false);
});

test("setBubblePos clamp 在视口内并持久化", () => {
	useBrowserStore.getState().setBubblePos({ x: -20, y: 99999 });
	const p = useBrowserStore.getState().bubblePos;
	expect(p.x).toBeGreaterThanOrEqual(0);
	expect(p.y).toBeLessThanOrEqual(window.innerHeight - 44);
	const saved = JSON.parse(localStorage.getItem("hiagent.browser.bubblePos")!);
	expect(saved.x).toBe(p.x);
	expect(saved.y).toBe(p.y);
});

test("activateSession 记录当前会话预览、恢复目标会话预览", () => {
	useBrowserStore.getState().openBrowser("/a/index.html", "A");
	expect(useBrowserStore.getState().sessionId).toBe("A");
	expect(useBrowserStore.getState().open).toBe(true);

	// 切到从未打开预览的 B：A 被记住，B 显示空预览
	useBrowserStore.getState().activateSession("B");
	expect(useBrowserStore.getState().sessionId).toBe("B");
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().path).toBeNull();

	// B 打开自己的预览
	useBrowserStore.getState().openBrowser("/b/index.html", "B");
	expect(useBrowserStore.getState().path).toBe("/b/index.html");

	// 切回 A：B 被记住，A 的预览恢复
	useBrowserStore.getState().activateSession("A");
	expect(useBrowserStore.getState().sessionId).toBe("A");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/a/index.html");

	// 再切回 B：A 被记住，B 的预览恢复
	useBrowserStore.getState().activateSession("B");
	expect(useBrowserStore.getState().sessionId).toBe("B");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/b/index.html");
});

test("closeBrowser 清空当前会话预览记忆", () => {
	useBrowserStore.getState().openBrowser("/a/index.html", "A");
	useBrowserStore.getState().closeBrowser();
	// 切走再切回 A，预览应保持关闭
	useBrowserStore.getState().activateSession("B");
	useBrowserStore.getState().activateSession("A");
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().path).toBeNull();
});

test("setPath / setMinimized 同步到当前会话记忆", () => {
	useBrowserStore.getState().openBrowser("/a/index.html", "A");
	useBrowserStore.getState().setPath("/a/v2.html");
	useBrowserStore.getState().setMinimized(true);
	useBrowserStore.getState().activateSession("B");
	useBrowserStore.getState().activateSession("A");
	expect(useBrowserStore.getState().path).toBe("/a/v2.html");
	expect(useBrowserStore.getState().minimized).toBe(true);
});

test("切到从未见过的会话默认空预览", () => {
	useBrowserStore.getState().openBrowser("/a/index.html", "A");
	useBrowserStore.getState().activateSession("Z");
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().path).toBeNull();
	expect(useBrowserStore.getState().minimized).toBe(false);
});

test("activateSession(null)：切到无会话（新建/空视图）关闭预览但保留原会话记忆，切回恢复", () => {
	useBrowserStore.getState().openBrowser("/a/index.html", "A");
	expect(useBrowserStore.getState().open).toBe(true);

	// 切到 null（无会话，如新建会话页）：预览应关闭，但 A 的记忆保留
	useBrowserStore.getState().activateSession(null);
	expect(useBrowserStore.getState().sessionId).toBeNull();
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().path).toBeNull();

	// 切回 A：恢复预览（“切走关闭，切回恢复”语义）
	useBrowserStore.getState().activateSession("A");
	expect(useBrowserStore.getState().sessionId).toBe("A");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/a/index.html");
});

// ── 独立预览窗口（float 模式的承载者）的窗口 rect ──
// 屏幕坐标：允许副屏负坐标、允许大于主窗口视口，故不能复用 clampRect（视口 clamp）。

test("setDetachedRect：屏幕坐标不夹到主窗口视口，仅约束最小尺寸并持久化", () => {
	useBrowserStore
		.getState()
		.setDetachedRect({ x: -1920, y: -240, w: 100, h: 50 });
	const r = useBrowserStore.getState().detachedRect!;
	expect(r.x).toBe(-1920); // 副屏（主屏左侧）负坐标合法
	expect(r.y).toBe(-240);
	expect(r.w).toBe(320); // 最小宽
	expect(r.h).toBe(240); // 最小高
	expect(
		JSON.parse(localStorage.getItem("hiagent.browser.detachedRect")!),
	).toEqual(r);
});

test("clampDetachedRect：超大尺寸不裁剪（独立窗口可大于主窗口视口）", () => {
	expect(clampDetachedRect({ x: 0, y: 0, w: 99999, h: 99999 })).toEqual({
		x: 0,
		y: 0,
		w: 99999,
		h: 99999,
	});
});

test("clampDetachedRect：非有限数回退（NaN 坐标会让 setBounds 静默失败）", () => {
	expect(clampDetachedRect({ x: NaN, y: Infinity, w: 800, h: 600 })).toEqual({
		x: 0,
		y: 0,
		w: 800,
		h: 600,
	});
	expect(clampDetachedRect({ x: 10, y: 20, w: NaN, h: NaN })).toEqual({
		x: 10,
		y: 20,
		w: 320,
		h: 240,
	});
});

test("独立窗口 rect 与浮窗 rect 互不干扰（两套持久化键各写各的）", () => {
	useBrowserStore.getState().setDetachedRect({ x: 40, y: 80, w: 900, h: 700 });
	useBrowserStore.getState().setFloatRect({ x: 10, y: 20, w: 640, h: 400 });
	expect(useBrowserStore.getState().detachedRect).toEqual({
		x: 40,
		y: 80,
		w: 900,
		h: 700,
	});
	expect(JSON.parse(localStorage.getItem("hiagent.browser.floatRect")!).x).toBe(
		10,
	);
	expect(
		JSON.parse(localStorage.getItem("hiagent.browser.detachedRect")!).x,
	).toBe(40);
});

test("defaultBrowserMode：桌面端（有 Electron 桥）默认独立窗口承载；浏览器无桥回退分屏", () => {
	// 需求：默认浮窗——首次打开预览直接弹独立窗口
	expect(defaultBrowserMode(true)).toBe("float");
	// 浏览器 dev 没有窗口承载者，浮窗会表现为「打开预览毫无反应」，故回退内嵌分屏
	expect(defaultBrowserMode(false)).toBe("split");
});

test("resolveMode：float 需要 Electron 桥，无桥一律降级为分屏", () => {
	// 有桥：float 是合法偏好（桌面端独立窗口）
	expect(resolveMode("float", true)).toBe("float");
	// 无桥（浏览器）：保留 float 会让预览失去承载者 → 降级为分屏
	expect(resolveMode("float", false)).toBe("split");
	// 其余合法值不受影响
	expect(resolveMode("split", true)).toBe("split");
	expect(resolveMode("full", false)).toBe("full");
	// 无记录/非法值 → 默认（桌面端独立窗口、浏览器分屏）
	expect(resolveMode(null, true)).toBe("float");
	expect(resolveMode(null, false)).toBe("split");
	expect(resolveMode("bogus", false)).toBe("split");
	expect(resolveMode("bogus", true)).toBe("float");
});

test("resolveMode 只做读时降级：不覆盖同 origin 的桌面端 float 偏好", () => {
	localStorage.setItem("hiagent.browser.mode", "float");
	expect(resolveMode(localStorage.getItem("hiagent.browser.mode"), false)).toBe(
		"split",
	);
	// 原始偏好保持不动（桌面端下次读到的仍是 float）
	expect(localStorage.getItem("hiagent.browser.mode")).toBe("float");
});
