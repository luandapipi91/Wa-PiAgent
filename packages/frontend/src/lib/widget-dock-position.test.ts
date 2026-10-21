import { test, expect, beforeEach, afterEach } from "bun:test";
import {
	clampDockOffset,
	computeDockBounds,
	loadDockOffset,
	saveDockOffset,
	DOCK_STORAGE_KEY,
	DEFAULT_DOCK_OFFSET,
} from "./widget-dock-position";

// === clampDockOffset：纯函数，越界取边界值 ===

test("clampDockOffset：范围内保持不变", () => {
	const bounds = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
	expect(clampDockOffset({ x: 10, y: -20 }, bounds)).toEqual({ x: 10, y: -20 });
});

test("clampDockOffset：四个角与越界都夹到边界", () => {
	const bounds = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
	expect(clampDockOffset({ x: -999, y: -999 }, bounds)).toEqual({
		x: -100,
		y: -50,
	});
	expect(clampDockOffset({ x: 999, y: 999 }, bounds)).toEqual({ x: 100, y: 50 });
	expect(clampDockOffset({ x: -999, y: 999 }, bounds)).toEqual({
		x: -100,
		y: 50,
	});
	expect(clampDockOffset({ x: 999, y: -999 }, bounds)).toEqual({
		x: 100,
		y: -50,
	});
});

test("clampDockOffset：尺寸为 0（min===max）夹到该值", () => {
	expect(
		clampDockOffset({ x: 30, y: -30 }, { minX: 0, maxX: 0, minY: 0, maxY: 0 }),
	).toEqual({ x: 0, y: 0 });
});

test("clampDockOffset：非有限值按 0 处理", () => {
	const bounds = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
	expect(clampDockOffset({ x: NaN, y: Infinity }, bounds)).toEqual({
		x: 0,
		y: 0,
	});
});

// === computeDockBounds：默认矩形 + 可活动区域 → 偏移范围 ===

test("computeDockBounds：由默认矩形与容器矩形算出偏移范围", () => {
	const bounds = computeDockBounds(
		{ left: 600, top: 300, right: 1000, bottom: 330 },
		{ left: 0, top: 0, right: 1000, bottom: 700 },
		4,
	);
	expect(bounds).toEqual({ minX: -596, maxX: -4, minY: -296, maxY: 366 });
});

test("computeDockBounds：尺寸为 0 且无边距时全为 0", () => {
	expect(
		computeDockBounds(
			{ left: 0, top: 0, right: 0, bottom: 0 },
			{ left: 0, top: 0, right: 0, bottom: 0 },
			0,
		),
	).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
});

// === loadDockOffset / saveDockOffset：localStorage 持久化 + 容错 ===

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

test("loadDockOffset：无记录返回默认偏移 {0,0}", () => {
	expect(DEFAULT_DOCK_OFFSET).toEqual({ x: 0, y: 0 });
	expect(loadDockOffset()).toEqual(DEFAULT_DOCK_OFFSET);
});

test("loadDockOffset：读取有效记录", () => {
	localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ x: -40, y: 20 }));
	expect(loadDockOffset()).toEqual({ x: -40, y: 20 });
});

test("loadDockOffset：JSON 损坏回退默认且不抛错", () => {
	localStorage.setItem(DOCK_STORAGE_KEY, "{not json");
	expect(() => loadDockOffset()).not.toThrow();
	expect(loadDockOffset()).toEqual(DEFAULT_DOCK_OFFSET);
});

test("loadDockOffset：缺字段 / 非数值 / null 回退默认", () => {
	localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ x: 10 }));
	expect(loadDockOffset()).toEqual(DEFAULT_DOCK_OFFSET);

	localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ x: "10", y: 0 }));
	expect(loadDockOffset()).toEqual(DEFAULT_DOCK_OFFSET);

	localStorage.setItem(DOCK_STORAGE_KEY, "null");
	expect(loadDockOffset()).toEqual(DEFAULT_DOCK_OFFSET);
});

test("loadDockOffset：localStorage 抛错回退默认且不抛错", () => {
	const proto = Object.getPrototypeOf(localStorage) as Storage;
	const original = proto.getItem;
	proto.getItem = () => {
		throw new Error("localStorage denied");
	};
	try {
		expect(() => loadDockOffset()).not.toThrow();
		expect(loadDockOffset()).toEqual(DEFAULT_DOCK_OFFSET);
	} finally {
		proto.getItem = original;
	}
});

test("saveDockOffset：写入 JSON", () => {
	saveDockOffset({ x: -12, y: 34 });
	expect(JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) as string)).toEqual({
		x: -12,
		y: 34,
	});
});

test("saveDockOffset：localStorage 抛错时静默降级", () => {
	const proto = Object.getPrototypeOf(localStorage) as Storage;
	const original = proto.setItem;
	proto.setItem = () => {
		throw new Error("quota exceeded");
	};
	try {
		expect(() => saveDockOffset({ x: 1, y: 2 })).not.toThrow();
	} finally {
		proto.setItem = original;
	}
});
