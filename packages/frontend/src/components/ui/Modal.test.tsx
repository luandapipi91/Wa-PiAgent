// Modal 通用弹窗测试：默认点击遮罩不关闭（防误触丢输入），显式 closeOnOverlayClick=true 才关闭；ESC 始终关闭
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

beforeEach(() => localStorage.clear());

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

// ─── draggable：按住标题栏（data-modal-drag-handle）拖动窗口位置 ───

test("draggable：拖把手移动卡片，拖动中直接写 DOM、mouseup 一次性回调最终位置", () => {
	const result: { pos: { left: number; top: number } | null } = { pos: null };
	render(
		<Modal
			draggable
			onClose={() => {}}
			onMove={(p) => {
				result.pos = p;
			}}
		>
			<div data-modal-drag-handle>标题</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	fireEvent.mouseDown(screen.getByText("标题"), { clientX: 150, clientY: 100 });
	fireEvent.mouseMove(window, { clientX: 250, clientY: 180 });
	expect(card.style.left).toBe("200px");
	expect(card.style.top).toBe("160px");
	// 拖动中脱离 flex 居中，转 fixed 定位钉住当前位置
	expect(card.style.position).toBe("fixed");
	expect(result.pos).toBeNull(); // 拖动中不回调，mouseup 才提交
	fireEvent.mouseUp(window);
	expect(result.pos).toEqual({ left: 200, top: 160 });
});

test("draggable：非把手区域按下不拖动窗口（内容区行为不变）", () => {
	render(
		<Modal draggable onClose={() => {}}>
			<div>正文</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	fireEvent.mouseDown(screen.getByText("正文"), { clientX: 150, clientY: 100 });
	fireEvent.mouseMove(window, { clientX: 250, clientY: 180 });
	expect(card.style.left).toBe("");
	expect(card.style.top).toBe("");
	expect(card.style.position).toBe("relative");
});

test("draggable：把手上的按钮按下不拖动（按钮保持原行为）", () => {
	render(
		<Modal draggable onClose={() => {}}>
			<div data-modal-drag-handle>
				<button data-testid="hdr-btn">关闭</button>
			</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	fireEvent.mouseDown(screen.getByTestId("hdr-btn"), {
		clientX: 150,
		clientY: 100,
	});
	fireEvent.mouseMove(window, { clientX: 250, clientY: 180 });
	expect(card.style.left).toBe("");
	expect(card.style.position).toBe("relative");
});

test("draggable：拖动位置被 clamp 在视口内（整体可见）", () => {
	render(
		<Modal draggable onClose={() => {}}>
			<div data-modal-drag-handle>标题</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	const handle = screen.getByText("标题");
	fireEvent.mouseDown(handle, { clientX: 150, clientY: 100 });
	// happy-dom 视口 1024×768；卡片 400×300 → 左上角上限 624/468
	fireEvent.mouseMove(window, { clientX: 5000, clientY: 5000 });
	expect(card.style.left).toBe("624px");
	expect(card.style.top).toBe("468px");
	fireEvent.mouseMove(window, { clientX: 0, clientY: 0 });
	expect(card.style.left).toBe("0px");
	expect(card.style.top).toBe("0px");
	fireEvent.mouseUp(window);
});

test("positionStorageKey：打开时按记录位置 fixed 定位", () => {
	localStorage.setItem(
		"test.modal.pos",
		JSON.stringify({ left: 30, top: 40 }),
	);
	render(
		<Modal
			draggable
			positionStorageKey="test.modal.pos"
			onClose={() => {}}
		>
			<div data-modal-drag-handle>标题</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	expect(card.style.position).toBe("fixed");
	expect(card.style.left).toBe("30px");
	expect(card.style.top).toBe("40px");
});

test("positionStorageKey：出界坐标被夹回视口内", () => {
	localStorage.setItem(
		"test.modal.pos",
		JSON.stringify({ left: 5000, top: 5000 }),
	);
	render(
		<Modal
			draggable
			positionStorageKey="test.modal.pos"
			onClose={() => {}}
		>
			<div data-modal-drag-handle>标题</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	const left = Number.parseFloat(card.style.left);
	const top = Number.parseFloat(card.style.top);
	expect(left).toBeGreaterThanOrEqual(0);
	expect(left).toBeLessThanOrEqual(1024);
	expect(top).toBeGreaterThanOrEqual(0);
	expect(top).toBeLessThanOrEqual(768);
});

test("positionStorageKey：拖动结束写入记录（关闭重开可恢复）", () => {
	render(
		<Modal
			draggable
			positionStorageKey="test.modal.pos"
			onClose={() => {}}
		>
			<div data-modal-drag-handle>标题</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	fireEvent.mouseDown(screen.getByText("标题"), { clientX: 150, clientY: 100 });
	fireEvent.mouseMove(window, { clientX: 250, clientY: 180 });
	fireEvent.mouseUp(window);
	expect(JSON.parse(localStorage.getItem("test.modal.pos")!)).toEqual({
		left: 200,
		top: 160,
	});
});

test("未开启 draggable：把手按下也不移动（默认行为不变）", () => {
	render(
		<Modal onClose={() => {}}>
			<div data-modal-drag-handle>标题</div>
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	fireEvent.mouseDown(screen.getByText("标题"), { clientX: 150, clientY: 100 });
	fireEvent.mouseMove(window, { clientX: 250, clientY: 180 });
	expect(card.style.left).toBe("");
	expect(card.style.position).toBe("relative");
});

// ─── sizeStorageKey：拖手柄改尺寸后持久化，关闭重开按记录尺寸恢复 ───

test("sizeStorageKey：打开时按记录尺寸渲染", () => {
	localStorage.setItem(
		"test.modal.size",
		JSON.stringify({ width: 640, height: 480 }),
	);
	render(
		<Modal resizable sizeStorageKey="test.modal.size" onClose={() => {}}>
			内容
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	expect(card.style.width).toBe("640px");
	expect(card.style.height).toBe("480px");
});

test("sizeStorageKey：记录尺寸超出视口时被夹回视口", () => {
	localStorage.setItem(
		"test.modal.size",
		JSON.stringify({ width: 99999, height: 99999 }),
	);
	render(
		<Modal resizable sizeStorageKey="test.modal.size" onClose={() => {}}>
			内容
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	expect(card.style.width).toBe("1024px");
	expect(card.style.height).toBe("768px");
});

test("sizeStorageKey：未传时用 width/height props（既有行为不变）", () => {
	render(
		<Modal width={520} height={360} onClose={() => {}}>
			内容
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	expect(card.style.width).toBe("520px");
	expect(card.style.height).toBe("360px");
});

test("sizeStorageKey：拖手柄改尺寸结束写入记录", () => {
	render(
		<Modal resizable sizeStorageKey="test.modal.size" onClose={() => {}}>
			内容
		</Modal>,
	);
	const card = screen.getByTestId("modal-content") as HTMLElement;
	mockCardRect(card, 100, 80, 400, 300);
	const handle = screen.getByTestId("modal-resize-handle");
	fireEvent.mouseDown(handle, { clientX: 500, clientY: 380 });
	fireEvent.mouseMove(window, { clientX: 600, clientY: 480 });
	fireEvent.mouseUp(window);
	expect(JSON.parse(localStorage.getItem("test.modal.size")!)).toEqual({
		width: 500,
		height: 400,
	});
});
