import { expect, test } from "bun:test";
import {
	composePrompt,
	DEFAULT_PROMPT_SEGMENTS,
	PROMPTS_SCHEMA_VERSION,
} from "../src/system-prompt";

// composePrompt 的 ctx 必填字段以 system-prompt.ts 的 SystemPromptContext 为准；
// 本测试只关心段序与 im-channel 段的显隐，其余动态段给空值即可
const baseCtx: any = {
	agentName: "前端开发者",
	defaultBasePrompt: "",
	builtinSkillsDir: "/tmp/skills",
	delegateRoster: "",
	memoryPolicy: "记忆策略",
	memorySnapshot: "",
	imChannelContext: undefined,
};

test("im-channel 段位于 env-constraints 之后、memory-policy 之前", () => {
	const ids = DEFAULT_PROMPT_SEGMENTS.map((s) => s.id);
	const env = ids.indexOf("env-constraints");
	const ch = ids.indexOf("im-channel");
	const mem = ids.indexOf("memory-policy");
	expect(ch).toBeGreaterThan(env);
	expect(ch).toBeLessThan(mem);
});

test("imChannelContext 为空 → 段不出现；有内容 → 出现在 memory-policy 之前", () => {
	const without = composePrompt(DEFAULT_PROMPT_SEGMENTS, baseCtx);
	expect(without).not.toContain("渠道专属规则");

	const withCtx = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
		...baseCtx,
		imChannelContext: "渠道专属规则：回复控制在200字",
	});
	expect(withCtx).toContain("渠道专属规则：回复控制在200字");
	expect(withCtx.indexOf("渠道专属规则")).toBeLessThan(
		withCtx.indexOf("记忆策略"),
	);
});

test("PROMPTS_SCHEMA_VERSION 已升到 24", () => {
	expect(PROMPTS_SCHEMA_VERSION).toBe(24);
});
