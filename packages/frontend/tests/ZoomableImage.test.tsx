// ZoomableImage 的平移语义：任何缩放（含 <100%）都能拖，且拖动过程中不会被夹回中心。
// 用户反馈的两个 bug 都出在这里：
//   1. 缩小到 100% 以下时拖不动（旧实现 `if (zoom <= 1) return`）；
//   2. 拖动中视角被莫名重置到中心（旧 clampPan 在 zoom<=1 时把平移量夹成 0）。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
	ZoomableImage,
	clampPan,
	type ImageTransform,
} from "../src/components/blocks/ZoomableImage";

let originalOffsetWidth: PropertyDescriptor | undefined;
let originalOffsetHeight: PropertyDescriptor | undefined;

/** 布局尺寸：happy-dom 不做布局，用固定值桩出来（图片 200×120，视口 500×400） */
beforeEach(() => {
	originalOffsetWidth = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"offsetWidth",
	);
	originalOffsetHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"offsetHeight",
	);
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get() {
			return this instanceof HTMLImageElement ? 200 : 500;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get() {
			return this instanceof HTMLImageElement ? 120 : 400;
		},
	});
});

afterEach(() => {
	cleanup();
	if (originalOffsetWidth)
		Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
	if (originalOffsetHeight)
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
});

/** 拖动图片：按下 → 移动 dx/dy → 松开 */
function dragImage(dx: number, dy: number) {
	const body = document.querySelector(
		"[data-testid='zoomable-image'] > div",
	) as HTMLElement;
	const img = screen.getByRole("img");
	fireEvent.mouseDown(body, { clientX: 100, clientY: 100 });
	act(() => {
		fireEvent.mouseMove(window, { clientX: 100 + dx, clientY: 100 + dy });
	});
	fireEvent.mouseUp(window);
	return img;
}

const transformOf = (el: HTMLElement) => el.style.transform;

test("clampPan：缩放 < 100% 时仍允许平移，只在「将要完全移出视口」处兜底", () => {
	// 70% 缩放下图片显示 140×84，视口 500×400 → 仍可自由拖动（旧实现这里恒为 0）
	const shrunk = clampPan({ x: 250, y: 150 }, 0.7, 200, 120, 500, 400);
	expect(shrunk).toEqual({ x: 250, y: 150 });
	// 只有把图整张甩出去才兜底：maxX = (500 + 200*0.7)/2 - 24 = 296、maxY = (400 + 84)/2 - 24 = 218
	const clamped = clampPan({ x: 9999, y: 9999 }, 0.7, 200, 120, 500, 400);
	expect(clamped.x).toBe(296);
	expect(clamped.y).toBe(218);
	// 放大时边界同步变大：(500 + 800)/2 - 24 = 626
	expect(clampPan({ x: 9999, y: 0 }, 4, 200, 120, 500, 400).x).toBe(626);
});

test("缩小到 100% 以下仍能拖动，且拖动过程中不会被夹回中心", () => {
	render(<ZoomableImage src="/a.png" alt="a.png" />);
	const img = screen.getByRole("img");

	// 先缩小到 70%
	fireEvent.wheel(document.querySelector("[data-testid='zoomable-image'] > div") as HTMLElement, {
		deltaY: 200,
	});
	act(() => {
		fireEvent.wheel(
			document.querySelector("[data-testid='zoomable-image'] > div") as HTMLElement,
			{ deltaY: 200 },
		);
	});

	// 连续拖两次：第一次 40px、第二次再 40px —— 第二次不能「跳回」中心
	dragImage(40, 20);
	expect(transformOf(img)).toContain("translate(40px, 20px)");
	dragImage(40, 20);
	expect(transformOf(img)).toContain("translate(80px, 40px)");
});

test("放大后拖动同样连续累加；松手后保持位置（不自动回中）", () => {
	render(<ZoomableImage src="/a.png" alt="a.png" />);
	const img = screen.getByRole("img");
	const body = document.querySelector(
		"[data-testid='zoomable-image'] > div",
	) as HTMLElement;
	// 放大两次
	for (let i = 0; i < 2; i += 1) {
		act(() => {
			fireEvent.wheel(body, { deltaY: -100 });
		});
	}
	expect(transformOf(img)).toContain("scale(");

	dragImage(30, -10);
	const after = transformOf(img);
	expect(after).toContain("translate(30px, -10px)");
	// 松手后（无任何新事件）位置保持
	expect(transformOf(img)).toBe(after);
});

test("onTransformChange 上报缩放与平移，供标注态接续同一视角", () => {
	const seen: ImageTransform[] = [];
	render(
		<ZoomableImage
			src="/a.png"
			alt="a.png"
			initialZoom={1.5}
			initialPan={{ x: 7, y: 9 }}
			onTransformChange={(t) => seen.push(t)}
		/>,
	);
	const img = screen.getByRole("img");
	expect(transformOf(img)).toContain("translate(7px, 9px)");
	expect(transformOf(img)).toContain("scale(1.5)");
	expect(seen.some((t) => t.zoom === 1.5 && t.pan.x === 7 && t.pan.y === 9)).toBe(
		true,
	);
});
