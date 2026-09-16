import { describe, expect, test } from "bun:test";
import {
	charWeighted,
	estimateContextTokens,
	estimateMessageTokens,
	estimateTextTokens,
	ESTIMATE_SAFETY,
	ESTIMATED_IMAGE_CHARS,
} from "../context-estimate";

describe("charWeighted / estimateTextTokens", () => {
	test("ASCII 每字符当量 1", () => {
		expect(charWeighted("abcd")).toBe(4);
		expect(charWeighted("")).toBe(0);
	});

	test("汉字 / 全角标点 / 假名 / 韩文每字符当量 4", () => {
		expect(charWeighted("中文")).toBe(8);
		expect(charWeighted("，")).toBe(4); // 全角逗号
		expect(charWeighted("　")).toBe(4); // 全角空格 U+3000
		expect(charWeighted("あ")).toBe(4); // 平假名
		expect(charWeighted("한")).toBe(4); // 韩文音节
	});

	test("中英混排按各自权重累加", () => {
		expect(charWeighted("a中")).toBe(5);
	});

	test("astral 码点（emoji）按 1 个字符当量计（不误判为 CJK）", () => {
		expect(charWeighted("😀")).toBe(1);
	});

	test("estimateTextTokens = ceil(加权字符数 / 4)：中文≈1 tok/字", () => {
		expect(estimateTextTokens("abcdefgh")).toBe(2);
		expect(estimateTextTokens("中国人")).toBe(3); // chars/4 口径会低估为 0.75
		expect(estimateTextTokens("汉字")).toBe(2);
	});
});

describe("estimateMessageTokens", () => {
	test("user 字符串内容", () => {
		expect(estimateMessageTokens({ role: "user", content: "abcd" })).toBe(1);
		expect(estimateMessageTokens({ role: "user", content: "中中中中" })).toBe(4);
	});

	test("image 块按 4800 字符当量（=1200 token）", () => {
		expect(
			estimateMessageTokens({ role: "user", content: [{ type: "image" }] }),
		).toBe(ESTIMATED_IMAGE_CHARS / 4);
		expect(
			estimateMessageTokens({
				role: "user",
				content: [{ type: "text", text: "abcd" }, { type: "image" }],
			}),
		).toBe(Math.ceil((4 + ESTIMATED_IMAGE_CHARS) / 4));
	});

	test("assistant 计 text + thinking + toolCall(name + JSON.stringify(arguments))", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "abcd" },
				{ type: "thinking", thinking: "中中" },
				{ type: "toolCall", name: "read", arguments: { a: 1 } },
			],
		};
		// 4 + 8 + (4 + '{"a":1}'.length=7) = 23 → ceil(23/4) = 6
		expect(estimateMessageTokens(msg)).toBe(6);
	});

	test("toolCall arguments 为中文时同样按加权计长", () => {
		// name "t"(1) + JSON.stringify({x:"中"})= '{"x":"中"}' → 9 字符，其中 1 个中文字符权重 4
		// 加权 = 1 + (9 - 1) + 4 = 13 → ceil(13/4) = 4
		expect(
			estimateMessageTokens({
				role: "assistant",
				content: [{ type: "toolCall", name: "t", arguments: { x: "中" } }],
			}),
		).toBe(4);
	});

	test("toolResult / custom 按 content 计", () => {
		expect(
			estimateMessageTokens({
				role: "toolResult",
				content: [{ type: "text", text: "abcdefgh" }],
			}),
		).toBe(2);
		expect(estimateMessageTokens({ role: "custom", content: "abcdefgh" })).toBe(
			2,
		);
	});

	test("bashExecution / 压缩摘要按 pi 口径计入", () => {
		expect(
			estimateMessageTokens({
				role: "bashExecution",
				command: "abc",
				output: "de",
			}),
		).toBe(2);
		expect(
			estimateMessageTokens({ role: "compactionSummary", summary: "abcdefgh" }),
		).toBe(2);
	});

	test("非法输入返回 0（不抛错）", () => {
		expect(estimateMessageTokens(null)).toBe(0);
		expect(estimateMessageTokens({ role: "unknown" })).toBe(0);
	});
});

describe("estimateContextTokens", () => {
	test("锚点 usage + 尾部估算 × 安全系数（锚点不乘）", () => {
		const messages = [
			{ role: "user", content: "hello world" }, // ceil(11/4)=3
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1000,
				content: [],
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
				},
			},
			{ role: "user", content: "abcdefgh" }, // 2
			{ role: "user", content: "中中中中" }, // 4
		];
		const est = estimateContextTokens(messages);
		// trailing raw = 6 → ceil(6 * 1.15) = 7
		expect(est.usageTokens).toBe(150);
		expect(est.trailingTokens).toBe(7);
		expect(est.tokens).toBe(157);
		expect(est.lastUsageIndex).toBe(1);
	});

	test("usage 优先 totalTokens，缺失/为 0 时回退各分量求和", () => {
		const withTotal = estimateContextTokens([
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1,
				content: [],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 3,
					cacheWrite: 2,
					totalTokens: 25,
				},
			},
		]);
		expect(withTotal.usageTokens).toBe(25);

		const fallback = estimateContextTokens([
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1,
				content: [],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 3,
					cacheWrite: 2,
					totalTokens: 0,
				},
			},
		]);
		expect(fallback.usageTokens).toBe(20);
	});

	test("锚点选择跳过 error / aborted / 无 usage / usage 为 0 的 assistant", () => {
		const messages = [
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1,
				content: [],
				usage: {
					input: 100,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
				},
			},
			{
				role: "assistant",
				stopReason: "error",
				timestamp: 2,
				content: [],
				usage: {
					input: 999,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 999,
				},
			},
			{
				role: "assistant",
				stopReason: "aborted",
				timestamp: 3,
				content: [],
				usage: {
					input: 888,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 888,
				},
			},
			{ role: "assistant", stopReason: "stop", timestamp: 4, content: [] },
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 5,
				content: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			},
		];
		const est = estimateContextTokens(messages);
		expect(est.lastUsageIndex).toBe(0);
		expect(est.usageTokens).toBe(100);
	});

	test("无有效锚点时全量估算 × 安全系数", () => {
		const messages = [
			{ role: "user", content: "abcdefgh" }, // 2
			{ role: "user", content: "中中中中" }, // 4
		];
		const est = estimateContextTokens(messages);
		// raw = 6 → ceil(6 * 1.15) = 7
		expect(est.usageTokens).toBe(0);
		expect(est.trailingTokens).toBe(7);
		expect(est.tokens).toBe(7);
		expect(est.lastUsageIndex).toBeNull();
	});

	test("afterTs：晚于压缩时刻的锚点可用", () => {
		const messages = [
			{ role: "user", content: "abcdefgh" },
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1000,
				content: [],
				usage: {
					input: 500,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 500,
				},
			},
		];
		const est = estimateContextTokens(messages, { afterTs: 500 });
		expect(est.lastUsageIndex).toBe(1);
		expect(est.usageTokens).toBe(500);
		expect(est.tokens).toBe(500);
	});

	test("afterTs：压缩前的锚点被丢弃 → 退回全量估算", () => {
		const messages = [
			{ role: "user", content: "abcdefgh" }, // 2
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1000,
				content: [],
				usage: {
					input: 500,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 500,
				},
			},
		];
		const est = estimateContextTokens(messages, { afterTs: 2000 });
		expect(est.lastUsageIndex).toBeNull();
		expect(est.usageTokens).toBe(0);
		// 全量：user 2 + assistant content 空 0 = 2 → ceil(2 * 1.15) = 3
		expect(est.tokens).toBe(3);
	});

	test("afterTs：锚点缺 timestamp 视为不可用", () => {
		const est = estimateContextTokens(
			[
				{
					role: "assistant",
					stopReason: "stop",
					content: [],
					usage: {
						input: 500,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 500,
					},
				},
			],
			{ afterTs: 1 },
		);
		expect(est.lastUsageIndex).toBeNull();
	});

	test("messages 为空 / 非数组时返回零值", () => {
		expect(estimateContextTokens([]).tokens).toBe(0);
		expect(estimateContextTokens(undefined as unknown as any[]).tokens).toBe(0);
	});

	test("CJK 估算显著高于 chars/4 口径（回归：中文长会话不再低估）", () => {
		// 1000 个汉字：chars/4 口径 = 250；加权口径 = 1000，无锚点再 ×1.15 → 1150
		const est = estimateContextTokens([
			{ role: "user", content: "中".repeat(1000) },
		]);
		expect(est.tokens).toBe(1150);
	});

	test("ESTIMATE_SAFETY 仅作用于尾部，锚点用量不被放大", () => {
		expect(ESTIMATE_SAFETY).toBe(1.15);
		const est = estimateContextTokens([
			{
				role: "assistant",
				stopReason: "stop",
				timestamp: 1,
				content: [],
				usage: {
					input: 1000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1000,
				},
			},
		]);
		expect(est.tokens).toBe(1000);
	});
});
