import { describe, expect, test } from "bun:test";
import {
	AUTO_COMPACT_RESERVE_TOKENS,
	shouldCompactBeforeSend,
} from "../auto-compact";

describe("shouldCompactBeforeSend", () => {
	test("占用远低于窗口时不压缩", () => {
		expect(shouldCompactBeforeSend(122_000, 1_000_000)).toBe(false);
	});

	test("占用 + 预留超过窗口时触发压缩", () => {
		expect(
			shouldCompactBeforeSend(1_000_000 - AUTO_COMPACT_RESERVE_TOKENS + 1, 1_000_000),
		).toBe(true);
	});

	test("边界：恰好等于窗口 − 预留时不压缩", () => {
		expect(
			shouldCompactBeforeSend(1_000_000 - AUTO_COMPACT_RESERVE_TOKENS, 1_000_000),
		).toBe(false);
	});

	test("不再按模型 maxTokens 预留：1M 窗口 70 万占用不触发", () => {
		// deepseek-v4：window=1M，catalog maxTokens=384K；旧逻辑 616K 就触发，新逻辑 967K 才触发
		expect(shouldCompactBeforeSend(700_000, 1_000_000)).toBe(false);
		expect(shouldCompactBeforeSend(968_000, 1_000_000)).toBe(true);
	});

	test("预留与社区做法一致：固定 33K", () => {
		expect(AUTO_COMPACT_RESERVE_TOKENS).toBe(33_000);
	});
});
