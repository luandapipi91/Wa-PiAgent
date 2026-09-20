// context-estimate.test.ts — pi 0.86+ role:"system" 消息的 token 估算（先红后绿）
import { describe, test, expect } from "bun:test";
import { estimateMessageTokens } from "../src/context-estimate";

describe("estimateMessageTokens：pi 0.86+ 的 system 消息", () => {
	test("sections 内容计入估算（content 为空字符串时按 sections 计）", () => {
		const tokens = estimateMessageTokens({
			role: "system",
			content: "",
			sections: { preamble: "a".repeat(400), tools: "b".repeat(400) },
		});
		expect(tokens).toBeGreaterThanOrEqual(150); // ≥800 chars / 4
	});

	test("content 为数组时按既有 text 口径 + sections 合并", () => {
		const tokens = estimateMessageTokens({
			role: "system",
			content: [{ type: "text", text: "x".repeat(400) }],
			sections: { tools: "y".repeat(400) },
		});
		expect(tokens).toBeGreaterThanOrEqual(150);
	});

	test("空 system 消息估算为 0", () => {
		expect(estimateMessageTokens({ role: "system", content: "" })).toBe(0);
	});
});
