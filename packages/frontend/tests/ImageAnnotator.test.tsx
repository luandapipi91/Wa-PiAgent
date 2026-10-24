// ImageAnnotator 组件测试：底部浮条结构、默认值、工具/颜色/粗细切换、绘制与撤销、
// 清空确认、折叠、文字输入、保存、取消与 Esc。
// happy-dom 无 canvas 2D 与真实图片解码，统一 mock：
// - HTMLCanvasElement.prototype.getContext → 记录调用的假 ctx（clearRect 次数 = 重绘次数）
// - HTMLCanvasElement.prototype.toBlob → 立即回调 Blob（走 renderAnnotatedBlob 的真实导出路径）
// - HTMLCanvasElement.prototype.getBoundingClientRect → 100×100（与图片自然尺寸一致，scale=1）
// - globalThis.Image → 赋 src 同步触发 onload，naturalWidth/Height = 100
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createRef } from "react";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
	act,
} from "@testing-library/react";
import i18n from "../src/i18n";
import {
	ImageAnnotator,
	type AnnotatorCancelResult,
	type AnnotatorHandle,
} from "../src/components/blocks/image-annotator/ImageAnnotator";

// 假 2D 上下文调用记录：断言绘制/重绘行为的唯一依据（happy-dom 无真实画布）。
const calls: string[] = [];

function makeFakeCtx() {
	return {
		font: "",
		textBaseline: "",
		strokeStyle: "",
		fillStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		save: () => calls.push("save"),
		restore: () => calls.push("restore"),
		beginPath: () => calls.push("beginPath"),
		closePath: () => calls.push("closePath"),
		moveTo: (x: number, y: number) => calls.push(`moveTo:${x},${y}`),
		lineTo: (x: number, y: number) => calls.push(`lineTo:${x},${y}`),
		quadraticCurveTo: () => calls.push("quadraticCurveTo"),
		stroke: () => calls.push("stroke"),
		fill: () => calls.push("fill"),
		arc: () => calls.push("arc"),
		ellipse: () => calls.push("ellipse"),
		strokeRect: (x: number, y: number, w: number, h: number) =>
			calls.push(`strokeRect:${x},${y},${w},${h}`),
		fillText: (text: string, x: number, y: number) =>
			calls.push(`fillText:${text},${x},${y}`),
		clearRect: () => calls.push("clearRect"),
		drawImage: () => calls.push("drawImage"),
		measureText: (text: string) => ({ width: text.length * 8 }),
	};
}

const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
let originalGetContext: unknown;
let originalToBlob: unknown;
let originalGetRect: unknown;
let originalImage: unknown;

beforeEach(() => {
	calls.length = 0;
	originalGetContext = canvasProto.getContext;
	originalToBlob = canvasProto.toBlob;
	originalGetRect = canvasProto.getBoundingClientRect;
	originalImage = (globalThis as Record<string, unknown>).Image;

	canvasProto.getContext = () => makeFakeCtx();
	canvasProto.toBlob = (cb: (blob: Blob | null) => void, mime: string) => {
		cb(new Blob(["png"], { type: mime }));
	};
	canvasProto.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
	(globalThis as Record<string, unknown>).Image = class {
		naturalWidth = 100;
		naturalHeight = 100;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(_value: string) {
			this.onload?.();
		}
	};
});

afterEach(() => {
	cleanup();
	canvasProto.getContext = originalGetContext;
	canvasProto.toBlob = originalToBlob;
	canvasProto.getBoundingClientRect = originalGetRect;
	(globalThis as Record<string, unknown>).Image = originalImage;
});

/** 重绘次数：每次全量重绘都以 clearRect 开始 */
const redraws = () => calls.filter((call) => call === "clearRect").length;

function setup(props: {
	onCancel?: ReturnType<typeof mock>;
	onSave?: (blob: Blob) => Promise<void>;
	initialZoom?: number;
	initialPan?: { x: number; y: number };
	onZoomChange?: (zoom: number) => void;
} = {}) {
	const onCancel = props.onCancel ?? mock();
	const onSave = props.onSave ?? mock(async () => {});
	render(
		<ImageAnnotator
			src="/proj/.wa-pi/uploads/a.png"
			alt="a.png"
			mime="image/png"
			onCancel={onCancel}
			onSave={onSave}
			initialZoom={props.initialZoom}
			initialPan={props.initialPan}
			onZoomChange={props.onZoomChange}
		/>,
	);
	return { onCancel, onSave };
}

const canvasOf = () =>
	screen.findByTestId("annotator-canvas") as Promise<HTMLCanvasElement>;

/** 一次完整的画笔拖拽（client 坐标 = 自然坐标，宿主 mock 比例为 1） */
function drawStroke(canvas: HTMLElement, to = { x: 60, y: 50 }) {
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 10,
		clientY: 10,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 30 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: to.x, clientY: to.y });
}

const undoBtn = () => screen.getByTestId("annotator-undo") as HTMLButtonElement;

/** 最近一次全量重绘产生的 ctx 调用（从最后一个 clearRect 开始） */
const lastRedraw = () => calls.slice(calls.lastIndexOf("clearRect"));

/** 用矩形工具拖一个包围盒（默认宿主 mock 比例为 1，client 坐标 = 自然坐标） */
function drawRectTool(
	canvas: HTMLElement,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
) {
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: x1,
		clientY: y1,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x2, clientY: y2 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x2, clientY: y2 });
}

test("渲染底部浮条：7 个工具（含手掌）、3 档粗细、8 个颜色、撤销/清空/取消/保存", async () => {
	setup();
	expect(screen.getByTestId("image-annotator")).toBeTruthy();
	expect(screen.getByTestId("annotator-bar")).toBeTruthy();
	for (const tool of ["hand", "arrow", "rect", "ellipse", "text", "pen", "eraser"]) {
		expect(screen.getByTestId(`annotator-tool-${tool}`)).toBeTruthy();
	}
	expect(
		screen.getByTestId("annotator-tools").querySelectorAll("button").length,
	).toBe(7);
	expect(
		screen.getByTestId("annotator-widths").querySelectorAll("button").length,
	).toBe(3);
	expect(
		screen.getByTestId("annotator-colors").querySelectorAll("button").length,
	).toBe(8);
	for (const id of [
		"annotator-undo",
		"annotator-clear",
		"annotator-cancel",
		"annotator-save",
	]) {
		expect(screen.getByTestId(id)).toBeTruthy();
	}
	// 画布尺寸取图片自然尺寸（坐标以自然像素存储）
	const canvas = await canvasOf();
	expect(canvas.width).toBe(100);
	expect(canvas.height).toBe(100);
});

test("默认工具画笔、颜色红、粗细中号", () => {
	setup();
	expect(
		screen.getByTestId("annotator-tool-pen").getAttribute("aria-pressed"),
	).toBe("true");
	expect(
		screen.getByTestId("annotator-color-E5484D").getAttribute("aria-pressed"),
	).toBe("true");
	expect(
		screen.getByTestId("annotator-width-medium").getAttribute("aria-pressed"),
	).toBe("true");
});

test("点击工具/颜色/粗细后选中态切换（不重置其他属性）", () => {
	setup();
	fireEvent.click(screen.getByTestId("annotator-tool-rect"));
	expect(
		screen.getByTestId("annotator-tool-rect").getAttribute("aria-pressed"),
	).toBe("true");
	expect(
		screen.getByTestId("annotator-tool-pen").getAttribute("aria-pressed"),
	).toBe("false");

	fireEvent.click(screen.getByTestId("annotator-color-3E63DD"));
	expect(
		screen.getByTestId("annotator-color-3E63DD").getAttribute("aria-pressed"),
	).toBe("true");
	expect(
		screen.getByTestId("annotator-color-E5484D").getAttribute("aria-pressed"),
	).toBe("false");
	// 切颜色不影响已选工具
	expect(
		screen.getByTestId("annotator-tool-rect").getAttribute("aria-pressed"),
	).toBe("true");

	fireEvent.click(screen.getByTestId("annotator-width-thick"));
	expect(
		screen.getByTestId("annotator-width-thick").getAttribute("aria-pressed"),
	).toBe("true");
	expect(
		screen.getByTestId("annotator-width-medium").getAttribute("aria-pressed"),
	).toBe("false");
});

test("画布重绘先铺原图：图片加载后 drawImage 打底，画布不只剩余标注线", async () => {
	setup();
	const canvas = await canvasOf();
	// 图片加载完成触发重绘：清屏 → 铺原图（漏这一步时用户看到的是空白画布）
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));
	const first = lastRedraw();
	expect(first[0]).toBe("clearRect");
	expect(first[1]).toBe("drawImage");

	// 画一笔后的重绘同样以原图打底
	drawStroke(canvas);
	await waitFor(() => expect(undoBtn().disabled).toBe(false));
	const after = lastRedraw();
	expect(after[0]).toBe("clearRect");
	expect(after[1]).toBe("drawImage");
	expect(after.some((call) => call.startsWith("lineTo:"))).toBe(true);
});

test("画笔拖拽提交后撤销：按钮回到禁用且画布重绘为空", async () => {
	setup();
	const canvas = await canvasOf();
	expect(undoBtn().disabled).toBe(true);
	drawStroke(canvas);
	await waitFor(() => expect(undoBtn().disabled).toBe(false));
	expect(calls.some((call) => call.startsWith("lineTo:"))).toBe(true);

	const before = redraws();
	fireEvent.click(undoBtn());
	await waitFor(() => expect(undoBtn().disabled).toBe(true));
	expect(redraws()).toBeGreaterThan(before);
	// 撤销后最后一次重绘：清屏 → 铺回原图 → 不再绘制任何图形
	expect(calls.slice(calls.lastIndexOf("clearRect"))).toEqual([
		"clearRect",
		"drawImage",
	]);
});

test("缩放：滚轮改 transform、双击重置、初始缩放沿用传入值", async () => {
	const zoomOf = (el: HTMLElement) => el.style.transform;
	setup({ initialZoom: 2, initialPan: { x: 12, y: -8 } });
	const canvas = await canvasOf();
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));

	// 进入编辑态沿用外面已经调好的视角，不重置回 100%
	expect(zoomOf(canvas)).toContain("scale(2)");
	expect(zoomOf(canvas)).toContain("translate(12px, -8px)");

	// 滚轮放大（绑在根容器上）：zoom 变大
	const root = screen.getByTestId("image-annotator");
	fireEvent.wheel(root, { deltaY: -100 });
	await waitFor(() => expect(zoomOf(canvas)).toContain("scale(2.2)"));

	// 双击重置
	fireEvent.doubleClick(canvas);
	await waitFor(() => expect(zoomOf(canvas)).toContain("scale(1)"));
	expect(zoomOf(canvas)).toContain("translate(0px, 0px)");
});

test("绘制坐标按 canvas.width / rect.width 换算（transform 已在 rect 内，缩放不需要另一套公式）", async () => {
	// happy-dom 的 rect 是固定桩、不随 transform 变化，这里锁住换算公式本身；
	// 真实缩放下 rect 会跟着放大（E2E 覆盖）
	setup();
	const canvas = await canvasOf();
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));
	fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 20, clientY: 10 });
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 20 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 40, clientY: 30 });
	await waitFor(() => expect(undoBtn().disabled).toBe(false));
	// rect 为 100×100、canvas 自然尺寸也是 100×100（beforeEach 的 mock），scale=1
	expect(lastRedraw()).toContain("moveTo:20,10");
	expect(lastRedraw()).toContain("lineTo:40,30");
});

test("缩小到 50% 时手掌仍可自由拖动，拖动中不被夹回中心", async () => {
	setup({ initialZoom: 0.5 });
	const canvas = await canvasOf();
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));
	// happy-dom 不做布局：给容器与画布桩出尺寸（画布 100×100、视口 500×400）
	const root = screen.getByTestId("image-annotator");
	for (const [el, w, h] of [
		[root, 500, 400],
		[canvas, 100, 100],
	] as [HTMLElement, number, number][]) {
		Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
		Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
	}
	fireEvent.click(screen.getByTestId("annotator-tool-hand"));

	const pan = (x1: number, y1: number, x2: number, y2: number) => {
		fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: x1, clientY: y1 });
		fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x2, clientY: y2 });
		fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x2, clientY: y2 });
	};

	// 连续两次平移：第二次相对第一次累加，说明没有被「重置回中心」
	pan(10, 10, 50, 30);
	await waitFor(() => expect(canvas.style.transform).toContain("translate(40px, 20px)"));
	pan(10, 10, 50, 30);
	await waitFor(() => expect(canvas.style.transform).toContain("translate(80px, 40px)"));
	// 缩小状态下平移同样不产生图形
	expect(undoBtn().disabled).toBe(true);
});

test("手掌模式：编辑区任意空白处都能拖（不必按在图片上），绘制工具下不铺该层", async () => {
	setup({ initialZoom: 0.5 });
	const canvas = await canvasOf();
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));
	const root = screen.getByTestId("image-annotator");
	for (const [el, w, h] of [
		[root, 500, 400],
		[canvas, 100, 100],
	] as [HTMLElement, number, number][]) {
		Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
		Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
	}

	// 默认画笔下没有手掌层（不会拦住绘制）
	expect(screen.queryByTestId("annotator-pan-layer")).toBeNull();
	fireEvent.click(screen.getByTestId("annotator-tool-hand"));
	const layer = screen.getByTestId("annotator-pan-layer");

	// 从图片外的空白处按下拖动（层铺满整块编辑区）
	fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 5, clientY: 5 });
	fireEvent.pointerMove(layer, { pointerId: 1, clientX: 65, clientY: 45 });
	fireEvent.pointerUp(layer, { pointerId: 1, clientX: 65, clientY: 45 });

	await waitFor(() =>
		expect(canvas.style.transform).toContain("translate(60px, 40px)"),
	);
	expect(undoBtn().disabled).toBe(true);
});

test("空格按住时同样铺手掌层（任何工具下都能从空白处拖动）", () => {
	setup();
	expect(screen.queryByTestId("annotator-pan-layer")).toBeNull();
	fireEvent.keyDown(window, { code: "Space" });
	expect(screen.getByTestId("annotator-pan-layer")).toBeTruthy();
	fireEvent.keyUp(window, { code: "Space" });
	expect(screen.queryByTestId("annotator-pan-layer")).toBeNull();
});

test("空格 + 拖拽平移视角：不产生图形；松手后恢复正常绘制", async () => {
	setup();
	const canvas = await canvasOf();
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));

	// 空格按住 → 抓手
	fireEvent.keyDown(window, { code: "Space" });
	await waitFor(() => expect(canvas.style.cursor).toBe("grab"));

	fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 35, clientY: 25 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 35, clientY: 25 });
	// 平移了视角，但没有画任何东西（撤销仍禁用）
	await waitFor(() => expect(canvas.style.transform).toContain("translate("));
	expect(undoBtn().disabled).toBe(true);

	// 松开空格 → 光标恢复十字，正常绘制
	fireEvent.keyUp(window, { code: "Space" });
	await waitFor(() => expect(canvas.style.cursor).toBe("crosshair"));
	drawStroke(canvas);
	await waitFor(() => expect(undoBtn().disabled).toBe(false));
});

test("再点一次已选中的工具 → 取消选中并切到手掌（每个工具都如此）", () => {
	setup();
	for (const tool of ["pen", "rect", "ellipse", "arrow", "text", "eraser"]) {
		// 先归零到手掌，再选中该工具（默认画笔已选中，直接点会走「取消」分支）
		fireEvent.click(screen.getByTestId("annotator-tool-hand"));
		fireEvent.click(screen.getByTestId(`annotator-tool-${tool}`));
		expect(
			screen.getByTestId(`annotator-tool-${tool}`).getAttribute("aria-pressed"),
		).toBe("true");
		// 再点一次 → 取消选中，切到手掌
		fireEvent.click(screen.getByTestId(`annotator-tool-${tool}`));
		expect(
			screen.getByTestId(`annotator-tool-${tool}`).getAttribute("aria-pressed"),
		).toBe("false");
		expect(
			screen.getByTestId("annotator-tool-hand").getAttribute("aria-pressed"),
		).toBe("true");
	}
});

test("手掌工具：拖拽只平移视角、不产生图形，光标为抓手指针", async () => {
	setup();
	const canvas = await canvasOf();
	await waitFor(() => expect(lastRedraw()).toContain("drawImage"));
	// 点手掌进入拖图模式（光标变抓手）
	fireEvent.click(screen.getByTestId("annotator-tool-hand"));
	expect(
		screen.getByTestId("annotator-tool-hand").getAttribute("aria-pressed"),
	).toBe("true");
	await waitFor(() => expect(canvas.style.cursor).toBe("grab"));

	fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 30 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 40, clientY: 30 });

	await waitFor(() => expect(canvas.style.transform).toContain("translate("));
	// 没有画出任何图形
	expect(undoBtn().disabled).toBe(true);
});

test("空拖拽（位移 < 2px）不产生图形，不留下隐形 shape", async () => {
	setup();
	const canvas = await canvasOf();
	fireEvent.click(screen.getByTestId("annotator-tool-rect"));
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 10,
		clientY: 10,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 11, clientY: 11 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 11, clientY: 11 });
	expect(undoBtn().disabled).toBe(true);
});

test("清空：内联确认条确认后画布清空，且清空本身可撤销", async () => {
	setup();
	drawStroke(await canvasOf());
	await waitFor(() => expect(undoBtn().disabled).toBe(false));

	const before = redraws();
	fireEvent.click(screen.getByTestId("annotator-clear"));
	expect(screen.getByTestId("annotator-confirm")).toBeTruthy();
	// 未确认前不动画面
	expect(redraws()).toBe(before);

	fireEvent.click(screen.getByTestId("annotator-confirm-yes"));
	await waitFor(() => expect(redraws()).toBeGreaterThan(before));
	expect(screen.queryByTestId("annotator-confirm")).toBeNull();
	// 清空后：清屏 → 铺回原图 → 没有图形
	expect(calls.slice(calls.lastIndexOf("clearRect"))).toEqual([
		"clearRect",
		"drawImage",
	]);
	expect(undoBtn().disabled).toBe(false);
});

test("浮条没有收起按钮：不再折叠成小笔，工具栏始终可见", () => {
	setup();
	expect(screen.getByTestId("annotator-bar")).toBeTruthy();
	// 保存按钮右侧不再有收起
	expect(screen.queryByTestId("annotator-collapse")).toBeNull();
	expect(screen.queryByTestId("annotator-expand")).toBeNull();
});

test("文字工具：点画布出现内联输入框，Enter 提交后重绘并生成图形", async () => {
	setup();
	const canvas = await canvasOf();
	fireEvent.click(screen.getByTestId("annotator-tool-text"));
	const before = redraws();

	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 20,
		clientY: 30,
	});
	const input = screen.getByTestId("annotator-text-input") as HTMLInputElement;
	fireEvent.change(input, { target: { value: "重点" } });
	fireEvent.keyDown(input, { key: "Enter" });

	expect(screen.queryByTestId("annotator-text-input")).toBeNull();
	await waitFor(() => expect(redraws()).toBeGreaterThan(before));
	expect(calls.some((call) => call.startsWith("fillText:"))).toBe(true);
	expect(undoBtn().disabled).toBe(false);
});

test("坐标换算：canvas 显示 50×50、图片 100×100 时坐标按 2 倍放大后绘制", async () => {
	setup();
	const canvas = await canvasOf();
	// 图片自然尺寸 100×100 被容器缩到 50×50 显示：client 坐标应为自然坐标的一半
	canvas.getBoundingClientRect = () => new DOMRect(0, 0, 50, 50);

	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 20,
		clientY: 10,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 20 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 40, clientY: 30 });

	// 断言真实绘制输出（drawShapes 的 ctx 调用），不依赖内部 state：
	// client (20,10) → 自然 (40,20)，依此类推
	const redraw = lastRedraw();
	expect(redraw).toContain("moveTo:40,20");
	expect(redraw).toContain("lineTo:60,40");
	expect(redraw).toContain("lineTo:80,60");
	expect(redraw).not.toContain("moveTo:20,10");
});

test("文字输入框按根容器定位：canvas 居中留白不错位、靠边不溢出", async () => {
	setup();
	const canvas = await canvasOf();
	const root = screen.getByTestId("image-annotator");
	// 根容器 300×200（viewport 原点 (30,40)），画布居中留白后位于 (100,50)、尺寸 100×100
	root.getBoundingClientRect = () => new DOMRect(30, 40, 300, 200);
	canvas.getBoundingClientRect = () => new DOMRect(130, 90, 100, 100);
	fireEvent.click(screen.getByTestId("annotator-tool-text"));

	// canvas 内 (20,10) → client (150,100)。input 的包含块是根容器，故偏移为 120/60
	//（若误用 canvas rect 会得到 20/10，即缺陷现场）
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 150,
		clientY: 100,
	});
	const input = screen.getByTestId("annotator-text-input") as HTMLInputElement;
	expect(input.style.left).toBe("120px");
	expect(input.style.top).toBe("60px");

	// 靠右下点击：夹取到容器内（输入框 112×28：300-112=188、200-28=172）
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 400,
		clientY: 300,
	});
	expect(input.style.left).toBe("188px");
	expect(input.style.top).toBe("172px");
});

test("橡皮擦：只删命中的图形，另一个保留，撤销可恢复", async () => {
	setup();
	const canvas = await canvasOf();
	fireEvent.click(screen.getByTestId("annotator-tool-rect"));
	drawRectTool(canvas, 10, 10, 30, 30);
	drawRectTool(canvas, 60, 60, 80, 80);
	expect(lastRedraw()).toContain("strokeRect:10,10,20,20");
	expect(lastRedraw()).toContain("strokeRect:60,60,20,20");

	fireEvent.click(screen.getByTestId("annotator-tool-eraser"));
	// 点左矩形上边框 (20,10)：只删它，右矩形保留
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 20,
		clientY: 10,
	});
	expect(lastRedraw()).not.toContain("strokeRect:10,10,20,20");
	expect(lastRedraw()).toContain("strokeRect:60,60,20,20");

	// 撤销把被擦的图形插回原位
	fireEvent.click(undoBtn());
	expect(lastRedraw()).toContain("strokeRect:10,10,20,20");
	expect(lastRedraw()).toContain("strokeRect:60,60,20,20");
});

test("橡皮擦：多图形同时命中时一次事件只删最上层一个", async () => {
	setup();
	const canvas = await canvasOf();
	fireEvent.click(screen.getByTestId("annotator-tool-rect"));
	// 两个矩形共享左边界 x=10：后画的 (10,10)-(70,70) 在最上层
	drawRectTool(canvas, 10, 10, 50, 50);
	drawRectTool(canvas, 10, 10, 70, 70);

	fireEvent.click(screen.getByTestId("annotator-tool-eraser"));
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 10,
		clientY: 30,
	});
	expect(lastRedraw()).not.toContain("strokeRect:10,10,60,60");
	expect(lastRedraw()).toContain("strokeRect:10,10,40,40");

	// 再擦一次才轮到下层
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 10,
		clientY: 30,
	});
	expect(lastRedraw()).not.toContain("strokeRect:10,10,40,40");
});

test("保存：导出 Blob 交给 onSave，保存中按钮禁用并显示 saving", async () => {
	let resolveSave: (() => void) | null = null;
	const onSave = mock(
		(_blob: Blob) =>
			new Promise<void>((resolve) => {
				resolveSave = resolve;
			}),
	);
	setup({ onSave });
	drawStroke(await canvasOf());

	const saveBtn = screen.getByTestId("annotator-save") as HTMLButtonElement;
	fireEvent.click(saveBtn);
	await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

	const blob = onSave.mock.calls[0]![0];
	expect(blob).toBeInstanceOf(Blob);
	expect(blob.type).toBe("image/png");
	// 导出走离屏 canvas：原图 + 标注一起绘制
	expect(calls).toContain("drawImage");

	expect(saveBtn.disabled).toBe(true);
	// key 必须真实存在（否则比对的只是 key 本身）
	const savingLabel = i18n.t("blocks.imageAnnotator.saving");
	expect(savingLabel).not.toBe("blocks.imageAnnotator.saving");
	expect(saveBtn.textContent).toContain(savingLabel);

	await act(async () => {
		resolveSave?.();
	});
	await waitFor(() => expect(saveBtn.disabled).toBe(false));
});

test("保存失败：恢复可再次保存，且保留全部图形", async () => {
	const onSave = mock(async () => {
		throw new Error("boom");
	});
	setup({ onSave });
	drawStroke(await canvasOf());

	const saveBtn = screen.getByTestId("annotator-save") as HTMLButtonElement;
	fireEvent.click(saveBtn);
	await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(saveBtn.disabled).toBe(false));
	// 图形未丢：撤销仍可用
	expect(undoBtn().disabled).toBe(false);
});

test("取消：无图形直接 onCancel(false)", async () => {
	const { onCancel } = setup();
	fireEvent.click(screen.getByTestId("annotator-cancel"));
	expect(onCancel).toHaveBeenCalledWith(false);
	expect(screen.queryByTestId("annotator-confirm")).toBeNull();
});

test("取消：有图形先弹确认，确认后 onCancel(true)", async () => {
	const { onCancel } = setup();
	drawStroke(await canvasOf());

	fireEvent.click(screen.getByTestId("annotator-cancel"));
	expect(onCancel).not.toHaveBeenCalled();
	expect(screen.getByTestId("annotator-confirm")).toBeTruthy();

	fireEvent.click(screen.getByTestId("annotator-confirm-yes"));
	expect(onCancel).toHaveBeenCalledTimes(1);
	expect(onCancel).toHaveBeenCalledWith(true);
});

test("Esc：有图形时弹确认，不直接退出", async () => {
	const { onCancel } = setup();
	drawStroke(await canvasOf());

	fireEvent.keyDown(window, { key: "Escape" });
	expect(screen.getByTestId("annotator-confirm")).toBeTruthy();
	expect(onCancel).not.toHaveBeenCalled();

	// 再按 Esc 先关确认条，仍不退出
	fireEvent.keyDown(window, { key: "Escape" });
	expect(screen.queryByTestId("annotator-confirm")).toBeNull();
	expect(onCancel).not.toHaveBeenCalled();

	// 点“取消”回到编辑态
	fireEvent.click(screen.getByTestId("annotator-cancel"));
	expect(screen.getByTestId("annotator-confirm")).toBeTruthy();
	fireEvent.click(screen.getByTestId("annotator-confirm-no"));
	expect(screen.queryByTestId("annotator-confirm")).toBeNull();
	expect(onCancel).not.toHaveBeenCalled();
});

test("图片加载失败：提示加载失败、不渲染画布、保存不可用", async () => {
	// 让 Image 打桩触发 onerror（渲染前改写）
	(globalThis as Record<string, unknown>).Image = class {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(_value: string) {
			this.onerror?.();
		}
	};
	setup();
	const label = i18n.t("blocks.imageAnnotator.loadFailed");
	expect(label).not.toBe("blocks.imageAnnotator.loadFailed");
	await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
	expect(screen.queryByTestId("annotator-canvas")).toBeNull();
	// 没有图片可导出：保存禁用
	expect(
		(screen.getByTestId("annotator-save") as HTMLButtonElement).disabled,
	).toBe(true);
});

test("图片尺寸超限（边长>8192 或 总像素>40MP）：提示超限、不渲染画布与浮条，取消回退", async () => {
	const label = i18n.t("blocks.imageAnnotator.tooLarge");
	expect(label).not.toBe("blocks.imageAnnotator.tooLarge");
	for (const [w, h] of [
		// 边长超限
		[9000, 100],
		// 40,008,000 像素：超过 40MP 十进制口径，但低于 40MiB（41,943,040）——
		// 这条用例把“40MP”钉在十进制 40,000,000，防止回退成 40 * 1024 * 1024
		[8000, 5001],
	]) {
		(globalThis as Record<string, unknown>).Image = class {
			naturalWidth = w;
			naturalHeight = h;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_value: string) {
				this.onload?.();
			}
		};
		const { onCancel } = setup();
		await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
		expect(screen.queryByTestId("annotator-canvas")).toBeNull();
		expect(screen.queryByTestId("annotator-bar")).toBeNull();

		fireEvent.click(screen.getByTestId("annotator-too-large-cancel"));
		expect(onCancel).toHaveBeenCalledWith(false);
		cleanup();
	}
});

test("恰好 40MP（8000×5000 = 40,000,000 像素）允许标注，不上报超限", async () => {
	(globalThis as Record<string, unknown>).Image = class {
		naturalWidth = 8000;
		naturalHeight = 5000;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(_value: string) {
			this.onload?.();
		}
	};
	setup();
	await waitFor(() => expect(screen.getByTestId("annotator-canvas")).toBeTruthy());
	expect(screen.queryByTestId("annotator-too-large")).toBeNull();
});

test("Ctrl+Z 撤销最后一步", async () => {
	setup();
	drawStroke(await canvasOf());
	await waitFor(() => expect(undoBtn().disabled).toBe(false));

	fireEvent.keyDown(window, { key: "z", ctrlKey: true });
	await waitFor(() => expect(undoBtn().disabled).toBe(true));
});

// ─── 审查修复：折叠态确认可见 / 导出失败反馈 / 输入法 Enter / 零图形 / pointercancel ───

test("请求退出（父组件 ✕）：有图形时弹丢弃确认条，不直接退出", async () => {
	const onCancel = mock();
	const apiRef = createRef<AnnotatorHandle>();
	render(
		<ImageAnnotator
			src="/proj/.wa-pi/uploads/a.png"
			alt="a.png"
			mime="image/png"
			onCancel={onCancel}
			onSave={async () => {}}
			apiRef={apiRef}
		/>,
	);
	drawStroke(await canvasOf());
	await waitFor(() => expect(undoBtn().disabled).toBe(false));

	let result: AnnotatorCancelResult | undefined;
	act(() => {
		result = apiRef.current?.requestCancel();
	});
	// 返回 confirming（父组件据此记下关窗意图），且界面上确认条真的出现了
	expect(result).toBe("confirming");
	expect(screen.getByTestId("annotator-confirm")).toBeTruthy();
	expect(onCancel).not.toHaveBeenCalled();

	// 确认丢弃照常退出
	fireEvent.click(screen.getByTestId("annotator-confirm-yes"));
	expect(onCancel).toHaveBeenCalledWith(true);
});

test("导出失败（toBlob 返回 null）：回调 onExportError，saving 复位、shapes 保留、不调 onSave", async () => {
	canvasProto.toBlob = (cb: (blob: Blob | null) => void) => cb(null);
	const onExportError = mock();
	const onSave = mock(async () => {});
	render(
		<ImageAnnotator
			src="/proj/.wa-pi/uploads/a.png"
			alt="a.png"
			mime="image/png"
			onCancel={mock()}
			onSave={onSave}
			onExportError={onExportError}
		/>,
	);
	drawStroke(await canvasOf());
	const saveBtn = screen.getByTestId("annotator-save") as HTMLButtonElement;

	fireEvent.click(saveBtn);
	await waitFor(() => expect(onExportError).toHaveBeenCalledTimes(1));
	// 导出就没成功：onSave 不该被调到（否则会误报「已保存」）
	expect(onSave).not.toHaveBeenCalled();
	// saving 复位：按钮回到可用，用户能重试
	await waitFor(() => expect(saveBtn.disabled).toBe(false));
	// 劳动成果保留
	expect(undoBtn().disabled).toBe(false);
});

test("文字输入：输入法组词中的 Enter 不提交，组词结束后才提交", async () => {
	setup();
	const canvas = await canvasOf();
	fireEvent.click(screen.getByTestId("annotator-tool-text"));
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 20,
		clientY: 30,
	});
	const input = screen.getByTestId("annotator-text-input") as HTMLInputElement;
	fireEvent.change(input, { target: { value: "重点" } });

	// 拼音选词按 Enter：不是提交
	fireEvent.keyDown(input, { key: "Enter", isComposing: true });
	expect(screen.getByTestId("annotator-text-input")).toBeTruthy();
	expect(undoBtn().disabled).toBe(true);

	// 组词结束后 Enter 正常提交
	fireEvent.keyDown(input, { key: "Enter", isComposing: false });
	expect(screen.queryByTestId("annotator-text-input")).toBeNull();
	await waitFor(() => expect(undoBtn().disabled).toBe(false));
});

test("零图形时保存按钮禁用（没有可导出的标注），画一笔后可用、撤销回零又禁用", async () => {
	setup();
	const saveBtn = screen.getByTestId("annotator-save") as HTMLButtonElement;
	expect(saveBtn.disabled).toBe(true);

	drawStroke(await canvasOf());
	await waitFor(() => expect(saveBtn.disabled).toBe(false));

	fireEvent.click(undoBtn());
	await waitFor(() => expect(saveBtn.disabled).toBe(true));
});

test("pointercancel（手势被系统接管）：丢弃草稿，不把半截图提交成图形", async () => {
	setup();
	const canvas = await canvasOf();
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 10,
		clientY: 10,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60, clientY: 50 });
	// 草稿已画出，但尚未提交
	expect(undoBtn().disabled).toBe(true);

	fireEvent.pointerCancel(canvas, { pointerId: 1 });
	// 没有留下图形（撤销仍禁用），最后一次重绘只剩清屏 + 原图
	expect(undoBtn().disabled).toBe(true);
	expect(calls.slice(calls.lastIndexOf("clearRect"))).toEqual([
		"clearRect",
		"drawImage",
	]);
});
