import { test, expect, beforeEach } from "bun:test";
import {
	useBrowserStore,
	clampRatio,
	clampRect,
} from "./browser";

beforeEach(() => {
	localStorage.clear();
	useBrowserStore.setState({
		open: false,
		path: null,
		sessionId: null,
		mode: "split",
		splitRatio: 0.5,
		floatRect: { x: 100, y: 60, w: 720, h: 480 },
	});
});

test("默认 split 模式、50/50 比例", () => {
	const s = useBrowserStore.getState();
	expect(s.mode).toBe("split");
	expect(s.splitRatio).toBe(0.5);
});

test("setMode 切换并持久化", () => {
	useBrowserStore.getState().setMode("float");
	expect(useBrowserStore.getState().mode).toBe("float");
	expect(localStorage.getItem("hiagent.browser.mode")).toBe("float");
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
