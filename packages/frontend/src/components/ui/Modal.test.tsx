// Modal 通用弹窗测试：默认点击遮罩不关闭（防误触丢输入），显式 closeOnOverlayClick=true 才关闭；ESC 始终关闭
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

test("默认点击遮罩 modal-overlay 不触发 onClose", () => {
	let closed = 0;
	render(
		<Modal onClose={() => closed++}>
			<div>内容</div>
		</Modal>,
	);
	fireEvent.click(screen.getByTestId("modal-overlay"));
	expect(closed).toBe(0);
});

test("closeOnOverlayClick=true 时点击遮罩触发 onClose", () => {
	let closed = 0;
	render(
		<Modal onClose={() => closed++} closeOnOverlayClick>
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

test("closeOnOverlayClick=false 时点击遮罩不关闭（显式关闭）", () => {
	let closed = 0;
	render(
		<Modal onClose={() => closed++} closeOnOverlayClick={false}>
			内容
		</Modal>,
	);
	fireEvent.click(screen.getByTestId("modal-overlay"));
	expect(closed).toBe(0);
});

// ─── resizable：右下角手柄拖动调整卡片大小（参考浮动预览窗交互） ───

// happy-dom 无真实布局：覆写 getBoundingClientRect 模拟卡片当前位置与尺寸
function mockCardRect(
	card: HTMLElement,
	left: number,
	top: number,
	width: number,
	height: number,
) {
	card.getBoundingClientRect = () => ({ left, top, width, height }) as DOMRect;
}

test("默认（非 resizable）不渲染缩放手柄", () => {
	render(<Modal onClose={() => {}}>内容</Modal>);
	expect(screen.queryByTestId("modal-resize-handle")).toBeNull();
});

test("resizable 渲染右下角缩放手柄，卡片 relative 锚定手柄", () => {
	render(
		<Modal resizable onClose={() => {}}>
			内容
		</Modal>,
	);
	expect(screen.getByTestId("modal-resize-handle")).toBeTruthy();
	const card = screen.getByTestId("modal-content") as HTMLElement;
	expect(card.style.position).toBe("relative");
});

test("resizable：拖手柄改卡片尺寸，左上角固定，mouseup 一次性回调最终尺寸", () => {
	// 对象包装：闭包内赋值，避免 TS 控制流把变量收窄成 null
	const result: { size: { width: number; height: number } | null } = {
		size: null,
	};
	render(
		<Modal
			resizable
			onClose={() => {}}
			onResize={(s) => {
				result.size = s;
			}}
		>
			内容
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	const handle = screen.getByTestId("modal-resize-handle");
	fireEvent.mouseDown(handle, { clientX: 500, clientY: 380 });
	// 拖动 +150/+120 → 550×420：拖拽中直接写 DOM（跟手），回调未触发
	fireEvent.mouseMove(window, { clientX: 650, clientY: 500 });
	expect(card.style.width).toBe("550px");
	expect(card.style.height).toBe("420px");
	// 左上角锚定：mousedown 时转 fixed 定位，拖右下角只改右下方向
	expect(card.style.position).toBe("fixed");
	expect(card.style.left).toBe("100px");
	expect(card.style.top).toBe("80px");
	expect(result.size).toBeNull();
	fireEvent.mouseUp(window);
	expect(result.size).toEqual({ width: 550, height: 420 });
});

test("resizable：拖动尺寸被 clamp（最小 320×240，最大不超视口）", () => {
	render(
		<Modal resizable onClose={() => {}}>
			内容
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	const handle = screen.getByTestId("modal-resize-handle");
	fireEvent.mouseDown(handle, { clientX: 500, clientY: 380 });
	// 拖到极小 → clamp 到最小 320×240
	fireEvent.mouseMove(window, { clientX: 0, clientY: 0 });
	expect(card.style.width).toBe("320px");
	expect(card.style.height).toBe("240px");
	// 拖到极大 → 不超过视口（happy-dom 默认 1024×768；上限 = 视口 − 锚定的左上角偏移）
	fireEvent.mouseMove(window, { clientX: 5000, clientY: 5000 });
	expect(card.style.width).toBe(`${1024 - 100}px`);
	expect(card.style.height).toBe(`${768 - 80}px`);
	fireEvent.mouseUp(window);
});
