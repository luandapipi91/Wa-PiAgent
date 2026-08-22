import { test, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { FloatWindow } from "./FloatWindow";

const RECT = { x: 100, y: 60, w: 720, h: 480 };

function setup() {
	const calls: { rects: any[] } = { rects: [] };
	render(
		<FloatWindow rect={RECT} onRectChange={(r) => calls.rects.push(r)}>
			<div>
				<button type="button" data-testid="inner-btn">
					按钮
				</button>
			</div>
		</FloatWindow>,
	);
	return calls;
}

test("按 rect 定位与尺寸渲染，无标题栏", () => {
	setup();
	const win = document.querySelector('[data-testid="float-window"]') as HTMLElement;
	expect(win.style.left).toBe("100px");
	expect(win.style.top).toBe("60px");
	expect(win.style.width).toBe("720px");
	expect(win.style.height).toBe("480px");
	expect(document.querySelector('[data-testid="float-titlebar"]')).toBeNull();
});

test("拖拽中直接改 DOM（跟手）且屏蔽内容区事件，mouseup 一次性提交", () => {
	const calls = setup();
	const win = document.querySelector('[data-testid="float-window"]') as HTMLElement;
	const content = document.querySelector('[data-testid="float-content"]') as HTMLElement;
	fireEvent.mouseDown(win, { clientX: 200, clientY: 100 });
	// 拖拽中：内容区 pointer-events:none（防 iframe 吞事件）
	expect(content.style.pointerEvents).toBe("none");
	fireEvent.mouseMove(window, { clientX: 230, clientY: 140 });
	// 拖拽中：DOM 立即跟随，但 store 未提交
	expect(win.style.left).toBe("130px");
	expect(win.style.top).toBe("100px");
	expect(calls.rects.length).toBe(0);
	fireEvent.mouseUp(window);
	// mouseup：一次性提交最终 rect，内容区事件恢复
	expect(calls.rects.length).toBe(1);
	expect(calls.rects[0]).toEqual({ x: 130, y: 100, w: 720, h: 480 });
	expect(content.style.pointerEvents).toBe("");
});

test("交互元素（按钮）上 mousedown 不触发拖动", () => {
	const calls = setup();
	const btn = document.querySelector('[data-testid="inner-btn"]')!;
	fireEvent.mouseDown(btn, { clientX: 200, clientY: 100 });
	fireEvent.mouseMove(window, { clientX: 260, clientY: 160 });
	fireEvent.mouseUp(window);
	expect(calls.rects.length).toBe(0);
});

test("拖右下角手柄：mouseup 提交新尺寸", () => {
	const calls = setup();
	const grip = document.querySelector('[data-testid="float-resize"]')!;
	fireEvent.mouseDown(grip, { clientX: 800, clientY: 500 });
	fireEvent.mouseMove(window, { clientX: 850, clientY: 560 });
	fireEvent.mouseUp(window);
	expect(calls.rects.length).toBe(1);
	expect(calls.rects[0]).toEqual({ x: 100, y: 60, w: 770, h: 540 });
});
