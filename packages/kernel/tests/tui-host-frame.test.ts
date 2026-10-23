import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { extractFrame, sameFrame } from "../src/tui-host/frame.ts";

describe("extractFrame", () => {
	test("无光标标记时原样返回，cursor 为 null", () => {
		const f = extractFrame(["hello", "world"]);
		expect(f.lines).toEqual(["hello", "world"]);
		expect(f.cursor).toBeNull();
	});

	test("定位并剥离光标标记，按可见宽度算列号（CJK 占两格）", () => {
		const f = extractFrame([`中文${CURSOR_MARKER}x`]);
		expect(f.lines).toEqual(["中文x"]);
		expect(f.cursor).toEqual({ row: 0, col: 4 });
	});

	test("只取第一个标记；多行时行号正确", () => {
		const f = extractFrame(["a", `b${CURSOR_MARKER}c`, `d${CURSOR_MARKER}`]);
		expect(f.lines).toEqual(["a", "bc", "d"]);
		expect(f.cursor).toEqual({ row: 1, col: 1 });
	});

	test("忽略 ANSI 颜色序列的宽度", () => {
		const f = extractFrame([`\u001b[31mab\u001b[0m${CURSOR_MARKER}`]);
		expect(f.cursor).toEqual({ row: 0, col: 2 });
	});

	test("空数组返回空帧", () => {
		const f = extractFrame([]);
		expect(f.lines).toEqual([]);
		expect(f.cursor).toBeNull();
	});
});

describe("sameFrame", () => {
	const base = { lines: ["a", "b"], cursor: { row: 1, col: 0 } };

	test("内容与光标全同时为 true", () => {
		expect(
			sameFrame(base, { lines: ["a", "b"], cursor: { row: 1, col: 0 } }),
		).toBe(true);
	});

	test("行内容变化为 false", () => {
		expect(
			sameFrame(base, { lines: ["a", "c"], cursor: { row: 1, col: 0 } }),
		).toBe(false);
	});

	test("行数变化为 false", () => {
		expect(sameFrame(base, { lines: ["a"], cursor: { row: 1, col: 0 } })).toBe(
			false,
		);
	});

	test("光标变化为 false；两边都无光标时为 true", () => {
		expect(sameFrame(base, { lines: ["a", "b"], cursor: null })).toBe(false);
		expect(
			sameFrame({ lines: ["z"], cursor: null }, { lines: ["z"], cursor: null }),
		).toBe(true);
	});

	test("前一帧为 null 时为 false（首次必然推送）", () => {
		expect(sameFrame(null, base)).toBe(false);
	});
});
