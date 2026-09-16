import { test, expect } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { FloatBubble } from "./FloatBubble";

const POS = { x: 500, y: 400 };

function setup() {
	const calls: { positions: any[]; restored: boolean } = {
		positions: [],
		restored: false,
	};
	render(
		<FloatBubble
			pos={POS}
			onPosChange={(p) => calls.positions.push(p)}
			onRestore={() => (calls.restored = true)}
		/>,
	);
	return calls;
}

test("按 pos 渲染", () => {
	setup();
	const bubble = document.querySelector(
		'[data-testid="float-bubble"]',
	) as HTMLElement;
	expect(bubble.style.left).toBe("500px");
	expect(bubble.style.top).toBe("400px");
});

test("点击（无位移）→ 恢复，不触发位置提交", () => {
	const calls = setup();
	const bubble = document.querySelector('[data-testid="float-bubble"]')!;
	fireEvent.mouseDown(bubble, { clientX: 520, clientY: 420 });
	fireEvent.mouseUp(window);
	expect(calls.restored).toBe(true);
	expect(calls.positions.length).toBe(0);
});

test("位移 ≤5px 仍算点击 → 恢复", () => {
	const calls = setup();
	const bubble = document.querySelector('[data-testid="float-bubble"]')!;
	fireEvent.mouseDown(bubble, { clientX: 520, clientY: 420 });
	fireEvent.mouseMove(window, { clientX: 523, clientY: 422 });
	fireEvent.mouseUp(window);
	expect(calls.restored).toBe(true);
	expect(calls.positions.length).toBe(0);
});

test("拖动 >5px → 提交新位置，不触发恢复", () => {
	const calls = setup();
	const bubble = document.querySelector('[data-testid="float-bubble"]')!;
	fireEvent.mouseDown(bubble, { clientX: 520, clientY: 420 });
	fireEvent.mouseMove(window, { clientX: 460, clientY: 360 });
	fireEvent.mouseUp(window);
	expect(calls.restored).toBe(false);
	expect(calls.positions.length).toBe(1);
	expect(calls.positions[0]).toEqual({ x: POS.x - 60, y: POS.y - 60 });
});
