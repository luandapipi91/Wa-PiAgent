import { describe, expect, test } from "bun:test";
import {
	AUTO_COMPACT_USAGE_RATIO,
	shouldCompactBeforeSend,
} from "../auto-compact";

describe("shouldCompactBeforeSend", () => {
	test("占用远低于 85% 时不压缩", () => {
		expect(shouldCompactBeforeSend(122_000, 1_000_000)).toBe(false);
	});

	test("占用不足 85% 时不压缩", () => {
		expect(shouldCompactBeforeSend(849_999, 1_000_000)).toBe(false);
	});

	test("恰好等于 85% 边界时不压缩（严格大于才触发）", () => {
		expect(shouldCompactBeforeSend(850_000, 1_000_000)).toBe(false);
	});

	test("占用超过 85% 时触发压缩", () => {
		expect(shouldCompactBeforeSend(850_001, 1_000_000)).toBe(true);
	});

	test("1M 窗口 70 万占用不触发，96.8 万触发", () => {
		expect(shouldCompactBeforeSend(700_000, 1_000_000)).toBe(false);
		expect(shouldCompactBeforeSend(968_000, 1_000_000)).toBe(true);
	});

	test("窗口非法时（<=0）不压缩", () => {
		expect(shouldCompactBeforeSend(100, 0)).toBe(false);
		expect(shouldCompactBeforeSend(100, -1)).toBe(false);
	});

	test("85% 阈值常量正确", () => {
		expect(AUTO_COMPACT_USAGE_RATIO).toBe(0.85);
	});
});
