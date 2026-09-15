// compaction-guard 纯逻辑单测（TDD：先于实现编写）
//
// 覆盖三块：① 摘要输出预算（自动检查上限）② 输入超窗口保护 ③ 被截断时按上限收尾。
// 被测模块 packages/kernel/src/compaction-guard.ts 由扩展 compaction-guard.extension.ts 复用。

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MIN_SUMMARY_TOKENS,
	DEFAULT_SAFETY_TOKENS,
	estimateTokens,
	extractAssistantText,
	finalizeSummary,
	planCompactionBudget,
	trimMessagesToBudget,
} from "../src/compaction-guard-core.ts";

describe("planCompactionBudget —— 自动检查上限", () => {
	test("窗口充足时，期望输出完整保留", () => {
		const p = planCompactionBudget({
			contextWindow: 1_000_000,
			modelMaxOutput: 384_000,
			wantOutput: 32_768,
			inputTokens: 1_000,
		});
		expect(p.desiredOutput).toBe(32_768);
		expect(p.maxTokens).toBe(32_768);
	});

	test("窗口较小时，期望输出被压到窗口的一半，给输入留空间", () => {
		const p = planCompactionBudget({
			contextWindow: 30_000,
			modelMaxOutput: 384_000,
			wantOutput: 32_768,
			inputTokens: 1_000,
		});
		expect(p.desiredOutput).toBe(15_000);
		expect(p.maxTokens).toBe(15_000);
	});

	test("输入很大时，输出预算取窗口剩余空间（减去安全余量）", () => {
		const p = planCompactionBudget({
			contextWindow: 128_000,
			modelMaxOutput: 384_000,
			wantOutput: 32_768,
			inputTokens: 120_000,
		});
		expect(p.maxTokens).toBe(128_000 - 120_000 - DEFAULT_SAFETY_TOKENS);
	});

	test("窗口装不下时回落到最小预算（调用方据此放弃接管）", () => {
		const p = planCompactionBudget({
			contextWindow: 10_000,
			modelMaxOutput: 384_000,
			wantOutput: 32_768,
			inputTokens: 50_000,
		});
		expect(p.maxTokens).toBe(DEFAULT_MIN_SUMMARY_TOKENS);
	});

	test("受模型输出上限约束", () => {
		const p = planCompactionBudget({
			contextWindow: 1_000_000,
			modelMaxOutput: 8_192,
			wantOutput: 32_768,
			inputTokens: 0,
		});
		expect(p.maxTokens).toBe(8_192);
	});

	test("窗口未知（<=0）时只受期望与模型上限约束", () => {
		const p = planCompactionBudget({
			contextWindow: 0,
			modelMaxOutput: 384_000,
			wantOutput: 32_768,
			inputTokens: 999,
		});
		expect(p.desiredOutput).toBe(32_768);
		expect(p.maxTokens).toBe(32_768);
	});
});

describe("trimMessagesToBudget —— 输入超窗口保护", () => {
	const serialize = (msgs: string[]) => msgs.join("\n");

	test("内容在预算内时不动它", () => {
		const r = trimMessagesToBudget(["甲".repeat(30), "乙".repeat(30)], {
			inputBudgetTokens: 100,
			serialize,
		});
		expect(r.dropped).toBe(0);
		expect(r.charsCut).toBe(0);
		expect(r.text).toBe(`${"甲".repeat(30)}\n${"乙".repeat(30)}`);
	});

	test("超预算时从最旧的消息开始丢弃，保留最近的消息", () => {
		const messages = ["最旧".repeat(100), "中间".repeat(100), "最新".repeat(100)];
		const r = trimMessagesToBudget(messages, {
			inputBudgetTokens: 100,
			serialize,
		});
		expect(r.dropped).toBeGreaterThan(0);
		expect(r.messages.length).toBeLessThan(messages.length);
		// 被保留下来的必定是尾部（最近的消息）
		expect(r.messages[r.messages.length - 1]).toBe(messages[messages.length - 1]);
		expect(estimateTokens(r.text)).toBeLessThanOrEqual(100);
	});

	test("只剩一条仍超预算时截断文本，保留尾部并加省略标记", () => {
		const messages = ["头".repeat(3_000)];
		const r = trimMessagesToBudget(messages, {
			inputBudgetTokens: 100,
			serialize,
		});
		expect(r.dropped).toBe(0);
		expect(r.charsCut).toBeGreaterThan(0);
		expect(r.text).toContain("已省略");
		expect(estimateTokens(r.text)).toBeLessThanOrEqual(100);
	});
});

describe("finalizeSummary —— 超出上限就按上限返回", () => {
	test("正常结束时原样返回", () => {
		expect(finalizeSummary("摘要正文", "stop", 32_768)).toBe("摘要正文");
	});

	test("因输出上限被截断时，采用正文并标注", () => {
		const s = finalizeSummary("摘要正文", "length", 1_200);
		expect(s).toContain("摘要正文");
		expect(s).toContain("1,200");
		expect(s).toContain("截断");
	});
});

describe("extractAssistantText", () => {
	test("只取正文，忽略 thinking 与工具调用", () => {
		const content = [
			{ type: "thinking", thinking: "内心戏" },
			{ type: "text", text: "第一段" },
			{ type: "toolCall", name: "bash", arguments: {} },
			{ type: "text", text: "第二段" },
		];
		expect(extractAssistantText(content)).toBe("第一段\n第二段");
	});

	test("非数组输入返回空串", () => {
		expect(extractAssistantText(undefined)).toBe("");
		expect(extractAssistantText("普通字符串")).toBe("");
	});
});

describe("estimateTokens", () => {
	test("按字符数保守估算（向上取整）", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abc")).toBe(1);
		expect(estimateTokens("abcd")).toBe(2);
	});
});
