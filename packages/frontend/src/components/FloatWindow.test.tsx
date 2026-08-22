import { test, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { FloatWindow } from "./FloatWindow";

const RECT = { x: 100, y: 60, w: 720, h: 480 };

function setup() {
	const calls: { rects: any[]; docked: boolean; closed: boolean } = {
		rects: [],
		docked: false,
		closed: false,
	};
	render(
		<FloatWindow
			rect={RECT}
			title="index.html"
			onRectChange={(r) => calls.rects.push(r)}
			onDock={() => (calls.docked = true)}
			onClose={() => (calls.closed = true)}
		>
			<div>内容</div>
		</FloatWindow>,
	);
	return calls;
}

test("按 rect 定位与尺寸渲染", () => {
	setup();
	const win = document.querySelector('[data-testid="float-window"]') as HTMLElement;
	expect(win.style.left).toBe("100px");
	expect(win.style.top).toBe("60px");
	expect(win.style.width).toBe("720px");
	expect(win.style.height).toBe("480px");
});

test("拖标题栏：onRectChange 收到位移后的 rect", () => {
	const calls = setup();
	const bar = document.querySelector('[data-testid="float-titlebar"]')!;
	fireEvent.mouseDown(bar, { clientX: 200, clientY: 100 });
	fireEvent.mouseMove(window, { clientX: 230, clientY: 140 });
	fireEvent.mouseUp(window);
	expect(calls.rects.length).toBeGreaterThan(0);
	const last = calls.rects[calls.rects.length - 1];
	expect(last.x).toBe(RECT.x + 30);
	expect(last.y).toBe(RECT.y + 40);
	expect(last.w).toBe(RECT.w);
});

test("拖右下角手柄：onRectChange 收到新尺寸", () => {
	const calls = setup();
	const grip = document.querySelector('[data-testid="float-resize"]')!;
	fireEvent.mouseDown(grip, { clientX: 800, clientY: 500 });
	fireEvent.mouseMove(window, { clientX: 850, clientY: 560 });
	fireEvent.mouseUp(window);
	const last = calls.rects[calls.rects.length - 1];
	expect(last.w).toBe(RECT.w + 50);
	expect(last.h).toBe(RECT.h + 60);
	expect(last.x).toBe(RECT.x);
});

test("停靠 / 关闭按钮触发回调", () => {
	const calls = setup();
	fireEvent.click(document.querySelector('[data-testid="float-dock"]')!);
	expect(calls.docked).toBe(true);
	fireEvent.click(document.querySelector('[data-testid="float-close"]')!);
	expect(calls.closed).toBe(true);
});
