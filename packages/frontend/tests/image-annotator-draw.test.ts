// 标注绘制纯函数单测：线宽换算、扩展名映射、命中测试、撤销操作栈、画布绘制与导出。
import { test, expect } from "bun:test";
import type { AnnotatorAction, Shape } from "../src/components/blocks/image-annotator/types";
import {
	ANNOTATOR_COLORS,
	drawShapes,
	hitTestShape,
	mimeForExt,
	normalizeRect,
	renderAnnotatedBlob,
	strokeWidthFor,
	undoAction,
} from "../src/components/blocks/image-annotator/draw";

// 记录调用的假 2D 上下文：happy-dom 无 canvas 实现，纯函数断言按调用序列验证。
function fakeCtx() {
	const calls: string[] = [];
	const raw = {
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
		stroke: () => calls.push("stroke"),
		fill: () => calls.push("fill"),
		arc: () => calls.push("arc"),
		ellipse: (x: number, y: number, rx: number, ry: number) =>
			calls.push(`ellipse:${x},${y},${rx},${ry}`),
		strokeRect: (x: number, y: number, w: number, h: number) =>
			calls.push(`strokeRect:${x},${y},${w},${h}`),
		fillText: (text: string, x: number, y: number) => calls.push(`fillText:${text},${x},${y}`),
	};
	return { ctx: raw as unknown as CanvasRenderingContext2D, calls, raw };
}

// 用假 canvas 顶替 document.createElement("canvas")，断言 renderAnnotatedBlob 的绘制与导出参数。
function stubCanvas(fake: {
	getContext: () => unknown;
	toBlob: (cb: (blob: Blob | null) => void, mime: string, quality: number) => void;
}) {
	const canvas = { width: 0, height: 0, ...fake };
	const orig = document.createElement.bind(document);
	document.createElement = ((tag: string) =>
		tag === "canvas" ? canvas : orig(tag)) as unknown as typeof document.createElement;
	return {
		canvas,
		restore: () => {
			document.createElement = orig as unknown as typeof document.createElement;
		},
	};
}

const rectShape: Shape = { kind: "rect", x: 0, y: 0, w: 100, h: 60, color: "#E5484D", width: 4 };
const textShape: Shape = { kind: "text", x: 10, y: 10, text: "标注", color: "#3E63DD", fontSize: 20 };

test("normalizeRect：反向拖拽返回正的宽高", () => {
	expect(normalizeRect(120, 90, 20, 30)).toEqual({ x: 20, y: 30, w: 100, h: 60 });
});

test("normalizeRect：零尺寸返回 w=0,h=0", () => {
	expect(normalizeRect(10, 20, 10, 20)).toEqual({ x: 10, y: 20, w: 0, h: 0 });
});

test("strokeWidthFor：按短边比例换算三档（2000×1000）", () => {
	expect(strokeWidthFor(2000, 1000, "thin")).toBe(3.5);
	expect(strokeWidthFor(2000, 1000, "medium")).toBe(7);
	expect(strokeWidthFor(2000, 1000, "thick")).toBe(14);
});

test("strokeWidthFor：下限夹取为 2（100×100 thin）", () => {
	expect(strokeWidthFor(100, 100, "thin")).toBe(2);
});

test("strokeWidthFor：上限夹取为 24（10000×10000 thick）", () => {
	expect(strokeWidthFor(10000, 10000, "thick")).toBe(24);
});

test("mimeForExt：png/jpg/jpeg/webp 映射，gif/svg/空串返回 null", () => {
	expect(mimeForExt("png")).toBe("image/png");
	expect(mimeForExt(".PNG")).toBe("image/png");
	expect(mimeForExt("jpg")).toBe("image/jpeg");
	expect(mimeForExt("jpeg")).toBe("image/jpeg");
	expect(mimeForExt("webp")).toBe("image/webp");
	expect(mimeForExt("gif")).toBeNull();
	expect(mimeForExt("svg")).toBeNull();
	expect(mimeForExt("")).toBeNull();
});

test("ANNOTATOR_COLORS：8 色板与规格 §3.4 一致", () => {
	expect(ANNOTATOR_COLORS).toEqual([
		"#E5484D",
		"#F76B15",
		"#F5C518",
		"#46A758",
		"#12B5B0",
		"#3E63DD",
		"#8E4EC6",
		"#1C2024",
	]);
});

test("hitTestShape stroke：点在线段上命中，远离不命中", () => {
	const stroke: Shape = {
		kind: "stroke",
		points: [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
		],
		color: "#E5484D",
		width: 4,
	};
	expect(hitTestShape(stroke, { x: 50, y: 2 })).toBe(true);
	expect(hitTestShape(stroke, { x: 50, y: 40 })).toBe(false);
});

test("hitTestShape rect：点边框命中，中心不命中", () => {
	expect(hitTestShape(rectShape, { x: 0, y: 30 })).toBe(true);
	expect(hitTestShape(rectShape, { x: 50, y: 30 })).toBe(false);
});

test("hitTestShape ellipse：点在椭圆边界命中，中心不命中", () => {
	const ellipse: Shape = { kind: "ellipse", x: 0, y: 0, w: 100, h: 60, color: "#E5484D", width: 4 };
	expect(hitTestShape(ellipse, { x: 100, y: 30 })).toBe(true);
	expect(hitTestShape(ellipse, { x: 50, y: 30 })).toBe(false);
});

test("hitTestShape arrow：线段中点命中，尖端外侧不命中", () => {
	const arrow: Shape = {
		kind: "arrow",
		x1: 0,
		y1: 0,
		x2: 100,
		y2: 0,
		color: "#E5484D",
		width: 4,
	};
	expect(hitTestShape(arrow, { x: 50, y: 0 })).toBe(true);
	expect(hitTestShape(arrow, { x: 110, y: 0 })).toBe(false);
});

test("hitTestShape text：包围盒内命中，盒外不命中", () => {
	// 包围盒宽 = 2 × 20 × 0.6 = 24，高 = 20 × 1.2 = 24
	expect(hitTestShape(textShape, { x: 20, y: 20 })).toBe(true);
	expect(hitTestShape(textShape, { x: 40, y: 20 })).toBe(false);
});

test("undoAction add：撤销移除末尾新增的 shape", () => {
	const action: AnnotatorAction = { type: "add", shape: textShape };
	expect(undoAction([rectShape, textShape], action)).toEqual([rectShape]);
});

test("undoAction erase：撤销按原 index 插回", () => {
	const a: Shape = { ...rectShape, color: "#46A758" };
	const erased: Shape = { ...rectShape, color: "#F76B15" };
	const action: AnnotatorAction = { type: "erase", shape: erased, index: 1 };
	expect(undoAction([a, rectShape], action)).toEqual([a, erased, rectShape]);
});

test("undoAction clear：撤销恢复整组", () => {
	const action: AnnotatorAction = { type: "clear", shapes: [rectShape, textShape] };
	expect(undoAction([], action)).toEqual([rectShape, textShape]);
});

test("undoAction erase：原 index 越界（图形已被移动）→ 追加到末尾", () => {
	const action: AnnotatorAction = { type: "erase", shape: textShape, index: 3 };
	expect(undoAction([rectShape], action)).toEqual([rectShape, textShape]);
});

test("drawShapes：按序绘制，矩形描边与文字字体/基线符合约定", () => {
	const { ctx, calls, raw } = fakeCtx();
	drawShapes(ctx, [rectShape, textShape]);
	expect(calls).toContain("strokeRect:0,0,100,60");
	expect(raw.font).toBe("20px system-ui, sans-serif");
	expect(raw.textBaseline).toBe("top");
	expect(calls).toContain("fillText:标注,10,10");
	expect(calls.indexOf("strokeRect:0,0,100,60")).toBeLessThan(calls.indexOf("fillText:标注,10,10"));
	expect(raw.lineWidth).toBe(4);
	expect(calls.filter((c) => c === "save")).toHaveLength(2);
	expect(calls.filter((c) => c === "restore")).toHaveLength(2);
});

test("renderAnnotatedBlob：按自然尺寸画原图与标注，按 mime 导出 Blob", async () => {
	const calls: unknown[][] = [];
	const { ctx } = fakeCtx();
	const drawn = {
		...ctx,
		drawImage: (...args: unknown[]) => calls.push(["drawImage", ...args]),
	};
	const blob = new Blob(["x"], { type: "image/webp" });
	const { canvas, restore } = stubCanvas({
		getContext: () => drawn,
		toBlob: (cb, mime, quality) => {
			calls.push(["toBlob", mime, quality]);
			cb(blob);
		},
	});
	try {
		const image = {} as CanvasImageSource;
		const out = await renderAnnotatedBlob(image, 200, 100, [], "image/webp");
		expect(out).toBe(blob);
		expect(canvas.width).toBe(200);
		expect(canvas.height).toBe(100);
		expect(calls[0]).toEqual(["drawImage", image, 0, 0, 200, 100]);
		expect(calls[1]).toEqual(["toBlob", "image/webp", 0.92]);
	} finally {
		restore();
	}
});

test("renderAnnotatedBlob：toBlob 返回 null 时 reject", async () => {
	const { ctx } = fakeCtx();
	const { restore } = stubCanvas({
		getContext: () => ({ ...ctx, drawImage: () => {} }),
		toBlob: (cb) => cb(null),
	});
	try {
		await expect(
			renderAnnotatedBlob({} as CanvasImageSource, 10, 10, [], "image/png"),
		).rejects.toThrow();
	} finally {
		restore();
	}
});
