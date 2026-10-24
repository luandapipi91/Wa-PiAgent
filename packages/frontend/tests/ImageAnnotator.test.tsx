// ImageAnnotator 组件测试：底部浮条结构、默认值、工具/颜色/粗细切换、绘制与撤销、
// 清空确认、折叠、文字输入、保存、取消与 Esc。
// happy-dom 无 canvas 2D 与真实图片解码，统一 mock：
// - HTMLCanvasElement.prototype.getContext → 记录调用的假 ctx（clearRect 次数 = 重绘次数）
// - HTMLCanvasElement.prototype.toBlob → 立即回调 Blob（走 renderAnnotatedBlob 的真实导出路径）
// - HTMLCanvasElement.prototype.getBoundingClientRect → 100×100（与图片自然尺寸一致，scale=1）
// - globalThis.Image → 赋 src 同步触发 onload，naturalWidth/Height = 100
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
	act,
} from "@testing-library/react";
import i18n from "../src/i18n";
import { ImageAnnotator } from "../src/components/blocks/image-annotator/ImageAnnotator";

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
		moveTo: () => calls.push("moveTo"),
		lineTo: () => calls.push("lineTo"),
		quadraticCurveTo: () => calls.push("quadraticCurveTo"),
		stroke: () => calls.push("stroke"),
		fill: () => calls.push("fill"),
		arc: () => calls.push("arc"),
		ellipse: () => calls.push("ellipse"),
		strokeRect: () => calls.push("strokeRect"),
		fillText: () => calls.push("fillText"),
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

test("渲染底部浮条：6 个工具、3 档粗细、8 个颜色、撤销/清空/取消/保存", async () => {
	setup();
	expect(screen.getByTestId("image-annotator")).toBeTruthy();
	expect(screen.getByTestId("annotator-bar")).toBeTruthy();
	for (const tool of ["arrow", "rect", "ellipse", "text", "pen", "eraser"]) {
		expect(screen.getByTestId(`annotator-tool-${tool}`)).toBeTruthy();
	}
	expect(
		screen.getByTestId("annotator-tools").querySelectorAll("button").length,
	).toBe(6);
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

test("画笔拖拽提交后撤销：按钮回到禁用且画布重绘为空", async () => {
	setup();
	const canvas = await canvasOf();
	expect(undoBtn().disabled).toBe(true);
	drawStroke(canvas);
	await waitFor(() => expect(undoBtn().disabled).toBe(false));
	expect(calls).toContain("lineTo");

	const before = redraws();
	fireEvent.click(undoBtn());
	await waitFor(() => expect(undoBtn().disabled).toBe(true));
	expect(redraws()).toBeGreaterThan(before);
	// 撤销后最后一次重绘只清屏、不再绘制任何图形
	expect(calls.slice(calls.lastIndexOf("clearRect"))).toEqual(["clearRect"]);
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
	expect(calls.slice(calls.lastIndexOf("clearRect"))).toEqual(["clearRect"]);
	expect(undoBtn().disabled).toBe(false);
});

test("折叠：浮条隐藏只剩小笔按钮，再点恢复浮条", () => {
	setup();
	fireEvent.click(screen.getByTestId("annotator-collapse"));
	expect(screen.queryByTestId("annotator-bar")).toBeNull();
	expect(screen.getByTestId("annotator-expand")).toBeTruthy();

	fireEvent.click(screen.getByTestId("annotator-expand"));
	expect(screen.getByTestId("annotator-bar")).toBeTruthy();
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
	expect(calls).toContain("fillText");
	expect(undoBtn().disabled).toBe(false);
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

test("Ctrl+Z 撤销最后一步", async () => {
	setup();
	drawStroke(await canvasOf());
	await waitFor(() => expect(undoBtn().disabled).toBe(false));

	fireEvent.keyDown(window, { key: "z", ctrlKey: true });
	await waitFor(() => expect(undoBtn().disabled).toBe(true));
});
