import { test, expect, beforeEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { FloatPreview } from "./FloatPreview";
import { useBrowserStore } from "../store/browser";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECT_KEY = "hiagent.browser.floatRect";

beforeEach(() => {
	localStorage.removeItem(RECT_KEY);
	useBrowserStore.setState({
		open: true,
		path: null,
		sessionId: null,
		mode: "float",
		splitRatio: 0.5,
		floatRect: { x: 100, y: 60, w: 720, h: 480 },
		minimized: false,
		bubblePos: { x: 500, y: 400 },
	});
});

test("无历史记录：首次打开双向居中并固化位置（重启后视口就绪也能居中）", () => {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const w = Math.min(720, vw - 80);
	const h = Math.min(480, vh - 80);
	useBrowserStore.setState({ floatRect: null });
	render(<FloatPreview />);
	// 惰性居中已固化到 store（下次重启直接恢复记录，不再依赖启动期视口）
	expect(useBrowserStore.getState().floatRect).toEqual({
		x: (vw - w) / 2,
		y: (vh - h) / 2,
		w,
		h,
	});
	// DOM 位置同步双向居中
	const win = document.querySelector(
		'[data-testid="float-window"]',
	) as HTMLElement;
	expect(win.style.left).toBe(`${(vw - w) / 2}px`);
	expect(win.style.top).toBe(`${(vh - h) / 2}px`);
});

test("最小化：窗口收缩后隐藏（保持挂载），气泡出现；恢复后窗口回来", async () => {
	render(<FloatPreview />);
	const win = document.querySelector(
		'[data-testid="float-window"]',
	) as HTMLElement;
	expect(win.style.width).toBe("720px");

	act(() => useBrowserStore.getState().setMinimized(true));
	await act(() => sleep(300));
	// hidden：display none 但仍在 DOM（保持挂载）
	expect(win.isConnected).toBe(true);
	expect(win.style.display).toBe("none");
	expect(document.querySelector('[data-testid="float-bubble"]')).toBeTruthy();

	act(() => useBrowserStore.getState().setMinimized(false));
	await act(() => sleep(300));
	expect(win.style.display).toBe("");
	expect(win.style.width).toBe("720px");
	expect(document.querySelector('[data-testid="float-bubble"]')).toBeNull();
});
