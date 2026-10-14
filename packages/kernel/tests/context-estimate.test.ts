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

	test("toolsAdded 计入估算（pi 1.2.0 estimateTokens 口径）", () => {
		// pi 的 system 分支在 sections 之后还有：toolsAdded 存在时按 JSON.stringify 长度计入，
		// 漏算会低估占用 → 压缩触发偏晚
		const tokens = estimateMessageTokens({
			role: "system",
			content: "",
			toolsAdded: { edit: { description: "x".repeat(400) } },
		});
		expect(tokens).toBeGreaterThanOrEqual(100);
	});

	test("空 system 消息估算为 0", () => {
		expect(estimateMessageTokens({ role: "system", content: "" })).toBe(0);
	});
});
