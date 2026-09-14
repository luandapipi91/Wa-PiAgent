import { test, expect, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { FloatPreview } from "./FloatPreview";
import { useBrowserStore } from "../store/browser";

// 浮动模式的呈现已改由独立系统窗口承担（能移出主窗口、与主窗口并行显示）：
// 主窗口侧只剩最小化后的气泡入口，故这里断言的是「没有 DOM 浮层 + 气泡是恢复入口」。
beforeEach(() => {
	useBrowserStore.setState({
		open: true,
		path: "/a.html",
		sessionId: null,
		mode: "float",
		minimized: false,
		bubblePos: { x: 500, y: 400 },
		bySession: {},
	});
});

test("非最小化：主窗口不渲染任何浮层（也不再有旧的内嵌浮窗）", () => {
	render(<FloatPreview />);
	expect(document.querySelector('[data-testid="float-bubble"]')).toBeNull();
	expect(document.querySelector('[data-testid="float-window"]')).toBeNull();
});

test("最小化：渲染气泡作为独立窗口的恢复入口，按持久化位置摆放", () => {
	useBrowserStore.setState({ minimized: true });
	render(<FloatPreview />);
	const bubble = document.querySelector(
		'[data-testid="float-bubble"]',
	) as HTMLElement;
	expect(bubble).toBeTruthy();
	expect(bubble.style.left).toBe("500px");
	expect(bubble.style.top).toBe("400px");
});

test("点击气泡（无位移）：清除最小化标记，显示独立窗口由 App 侧驱动下发", () => {
	useBrowserStore.setState({ minimized: true });
	render(<FloatPreview />);
	const bubble = document.querySelector('[data-testid="float-bubble"]')!;
	fireEvent.mouseDown(bubble, { clientX: 520, clientY: 420 });
	fireEvent.mouseUp(window);
	expect(useBrowserStore.getState().minimized).toBe(false);
});

test("拖动气泡：提交新停放位置，不恢复窗口", () => {
	useBrowserStore.setState({ minimized: true });
	render(<FloatPreview />);
	const bubble = document.querySelector('[data-testid="float-bubble"]')!;
	fireEvent.mouseDown(bubble, { clientX: 520, clientY: 420 });
	fireEvent.mouseMove(window, { clientX: 460, clientY: 360 });
	fireEvent.mouseUp(window);
	expect(useBrowserStore.getState().bubblePos).toEqual({ x: 440, y: 340 });
	expect(useBrowserStore.getState().minimized).toBe(true);
});
