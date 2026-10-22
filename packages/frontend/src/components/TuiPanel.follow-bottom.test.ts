// TuiPanel.follow-bottom.test.ts — 帧区贴底跟随判定（isScrolledAwayFromBottom）单测
//
// 背景：TUI 对话框的选项/确认区在帧尾，正文一长就被推出浮窗首屏。TuiPanel 帧
// 刷新时按本判定决定要不要自动贴底（用户未上滚才跟随），保证选项始终可见。
import { describe, expect, test } from "bun:test";
import { isScrolledAwayFromBottom } from "../lib/tui-follow";

const LH = 19.4; // 与 TuiPanel 的 CELL.height 同口径（行高 px）

describe("isScrolledAwayFromBottom", () => {
	test("贴底（距底 0）→ 未离开，继续跟随", () => {
		expect(isScrolledAwayFromBottom(100, 200, 300, LH)).toBe(false);
	});

	test("距底半行 → 未离开（微小抖动仍跟随）", () => {
		expect(isScrolledAwayFromBottom(100, 200, 300 + LH / 2, LH)).toBe(false);
	});

	test("距底恰好 1 行 → 未离开（阈值内）", () => {
		expect(isScrolledAwayFromBottom(100, 200, 300 + LH, LH)).toBe(false);
	});

	test("距底超过 1 行 → 已离开（用户在阅读正文，不拉回）", () => {
		expect(isScrolledAwayFromBottom(100, 200, 300 + LH * 1.5, LH)).toBe(true);
	});

	test("无滚动空间（内容不足一屏）→ 恒为未离开", () => {
		expect(isScrolledAwayFromBottom(0, 200, 150, LH)).toBe(false);
		expect(isScrolledAwayFromBottom(0, 200, 200, LH)).toBe(false);
	});
});
