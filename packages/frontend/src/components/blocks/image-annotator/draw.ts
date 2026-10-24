// 标注绘制纯函数：线宽换算、扩展名映射、命中测试、撤销操作栈、画布绘制与导出。
import type { AnnotatorAction, Point, Shape, StrokeLevel } from "./types";

// 颜色板（规格 §3.4）：红橙黄绿青蓝紫黑。
export const ANNOTATOR_COLORS: readonly string[] = [
	"#E5484D",
	"#F76B15",
	"#F5C518",
	"#46A758",
	"#12B5B0",
	"#3E63DD",
	"#8E4EC6",
	"#1C2024",
];

// 线宽三档以图片短边为基准，保证不同分辨率视觉一致；结果夹取 [2,24] 自然像素。
const STROKE_RATIO: Record<StrokeLevel, number> = {
	thin: 0.0035,
	medium: 0.007,
	thick: 0.014,
};
const MIN_STROKE = 2;
const MAX_STROKE = 24;

export function normalizeRect(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): { x: number; y: number; w: number; h: number } {
	return {
		x: Math.min(x1, x2),
		y: Math.min(y1, y2),
		w: Math.abs(x2 - x1),
		h: Math.abs(y2 - y1),
	};
}

export function strokeWidthFor(w: number, h: number, level: StrokeLevel): number {
	const raw = STROKE_RATIO[level] * Math.min(w, h);
	return Math.min(MAX_STROKE, Math.max(MIN_STROKE, raw));
}

export function mimeForExt(ext: string): string | null {
	const normalized = ext.toLowerCase().replace(/^\./, "");
	if (normalized === "png") return "image/png";
	if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
	if (normalized === "webp") return "image/webp";
	return null;
}

// 点到线段的距离，命中测试的基础。
function distToSegment(p: Point, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(p.x - x1, p.y - y1);
	const t = Math.min(1, Math.max(0, ((p.x - x1) * dx + (p.y - y1) * dy) / lenSq));
	return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

// 点到矩形边框的距离：框内取到最近边的距离，框外取欧氏距离。
function distToRectBorder(p: Point, x: number, y: number, w: number, h: number): number {
	const left = Math.min(x, x + w);
	const right = Math.max(x, x + w);
	const top = Math.min(y, y + h);
	const bottom = Math.max(y, y + h);
	const dx = Math.max(left - p.x, 0, p.x - right);
	const dy = Math.max(top - p.y, 0, p.y - bottom);
	if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
	return Math.min(p.x - left, right - p.x, p.y - top, bottom - p.y);
}

export function hitTestShape(shape: Shape, p: Point): boolean {
	if (shape.kind === "stroke") {
		const threshold = Math.max(shape.width, 4);
		if (shape.points.length === 0) return false;
		if (shape.points.length === 1) {
			const [only] = shape.points;
			return Math.hypot(p.x - only.x, p.y - only.y) <= threshold;
		}
		for (let i = 1; i < shape.points.length; i++) {
			const a = shape.points[i - 1];
			const b = shape.points[i];
			if (distToSegment(p, a.x, a.y, b.x, b.y) <= threshold) return true;
		}
		return false;
	}
	if (shape.kind === "text") {
		// 无 ctx 时用常数估算包围盒：宽 = 字数 × 字号 × 0.6，高 = 字号 × 1.2。
		const w = shape.text.length * shape.fontSize * 0.6;
		const h = shape.fontSize * 1.2;
		return p.x >= shape.x && p.x <= shape.x + w && p.y >= shape.y && p.y <= shape.y + h;
	}
	const threshold = Math.max(shape.width, 4);
	if (shape.kind === "arrow") {
		return distToSegment(p, shape.x1, shape.y1, shape.x2, shape.y2) <= threshold;
	}
	if (shape.kind === "rect") {
		return distToRectBorder(p, shape.x, shape.y, shape.w, shape.h) <= threshold;
	}
	// ellipse：归一化半径 k，|k-1| × 短半径 作为到边界的近似距离。
	const rx = Math.abs(shape.w) / 2;
	const ry = Math.abs(shape.h) / 2;
	if (rx === 0 || ry === 0) return false;
	const cx = shape.x + shape.w / 2;
	const cy = shape.y + shape.h / 2;
	const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
	return Math.abs(k - 1) * Math.min(rx, ry) <= threshold;
}

export function undoAction(shapes: Shape[], action: AnnotatorAction): Shape[] {
	if (action.type === "add") {
		// 按引用移除；找不到（已被别的历史改掉）则原样返回。
		const index = shapes.lastIndexOf(action.shape);
		if (index < 0) return shapes;
		return [...shapes.slice(0, index), ...shapes.slice(index + 1)];
	}
	if (action.type === "erase") {
		// 插回原 index；越界（图形已被移动）则追加到末尾。
		const index = Math.min(Math.max(action.index, 0), shapes.length);
		const next = shapes.slice();
		next.splice(index, 0, action.shape);
		return next;
	}
	return [...action.shapes];
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[]): void {
	for (const shape of shapes) {
		ctx.save();
		ctx.strokeStyle = shape.color;
		ctx.fillStyle = shape.color;
		if (shape.kind === "stroke") {
			ctx.lineWidth = shape.width;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			const [first, ...rest] = shape.points;
			if (!first) {
				ctx.restore();
				continue;
			}
			ctx.beginPath();
			ctx.moveTo(first.x, first.y);
			if (rest.length === 0) {
				// 单点：画一个实心圆点。
				ctx.arc(first.x, first.y, shape.width / 2, 0, Math.PI * 2);
				ctx.fill();
			} else {
				for (const point of rest) ctx.lineTo(point.x, point.y);
				ctx.stroke();
			}
		} else if (shape.kind === "arrow") {
			ctx.lineWidth = shape.width;
			ctx.lineCap = "round";
			ctx.beginPath();
			ctx.moveTo(shape.x1, shape.y1);
			ctx.lineTo(shape.x2, shape.y2);
			ctx.stroke();
			// 实心三角箭头，箭头长 = 4 × 线宽。
			const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
			const head = 4 * shape.width;
			const spread = Math.PI / 7;
			ctx.beginPath();
			ctx.moveTo(shape.x2, shape.y2);
			ctx.lineTo(
				shape.x2 - head * Math.cos(angle - spread),
				shape.y2 - head * Math.sin(angle - spread),
			);
			ctx.lineTo(
				shape.x2 - head * Math.cos(angle + spread),
				shape.y2 - head * Math.sin(angle + spread),
			);
			ctx.closePath();
			ctx.fill();
		} else if (shape.kind === "rect") {
			ctx.lineWidth = shape.width;
			ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
		} else if (shape.kind === "ellipse") {
			ctx.lineWidth = shape.width;
			ctx.beginPath();
			ctx.ellipse(
				shape.x + shape.w / 2,
				shape.y + shape.h / 2,
				Math.abs(shape.w) / 2,
				Math.abs(shape.h) / 2,
				0,
				0,
				Math.PI * 2,
			);
			ctx.stroke();
		} else {
			ctx.font = `${shape.fontSize}px system-ui, sans-serif`;
			ctx.textBaseline = "top";
			ctx.fillText(shape.text, shape.x, shape.y);
		}
		ctx.restore();
	}
}

export function renderAnnotatedBlob(
	image: CanvasImageSource,
	width: number,
	height: number,
	shapes: Shape[],
	mime: string,
): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return Promise.reject(new Error("canvas 2d context unavailable"));
	ctx.drawImage(image, 0, 0, width, height);
	drawShapes(ctx, shapes);
	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("canvas.toBlob 返回 null"));
			},
			mime,
			0.92,
		);
	});
}
