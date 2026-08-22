import { test, expect, beforeEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { FloatPreview } from "./FloatPreview";
import { useBrowserStore } from "../store/browser";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
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

test("最小化：窗口收缩后隐藏（保持挂载），气泡出现；恢复后窗口回来", async () => {
	render(<FloatPreview />);
	const win = document.querySelector('[data-testid="float-window"]') as HTMLElement;
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
