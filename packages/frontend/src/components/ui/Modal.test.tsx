// Modal 通用弹窗测试：遮罩点击/ESC 关闭（portal 到 body 后行为不变）
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

test("点击遮罩 modal-overlay 触发 onClose", () => {
	let closed = 0;
	render(
		<Modal onClose={() => closed++}>
			<div>内容</div>
		</Modal>,
	);
	fireEvent.click(screen.getByTestId("modal-overlay"));
	expect(closed).toBe(1);
});

test("点击卡片内容不触发 onClose（stopPropagation）", () => {
	let closed = 0;
	render(
		<Modal onClose={() => closed++} data-testid="modal-card">
			<button data-testid="inner-btn">内</button>
		</Modal>,
	);
	fireEvent.click(screen.getByTestId("inner-btn"));
	expect(closed).toBe(0);
});

test("ESC 触发 onClose", () => {
	let closed = 0;
	render(<Modal onClose={() => closed++}>内容</Modal>);
	fireEvent.keyDown(window, { key: "Escape" });
	expect(closed).toBe(1);
});

test("closeOnOverlayClick=false 时点击遮罩不关闭", () => {
	let closed = 0;
	render(
		<Modal onClose={() => closed++} closeOnOverlayClick={false}>
			内容
		</Modal>,
	);
	fireEvent.click(screen.getByTestId("modal-overlay"));
	expect(closed).toBe(0);
});
