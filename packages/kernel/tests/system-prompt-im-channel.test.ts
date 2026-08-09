import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composePrompt,
	DEFAULT_PROMPT_SEGMENTS,
	ensureImChannelSegment,
	loadPromptSegments,
	PROMPTS_SCHEMA_VERSION,
	savePromptSegments,
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

function tempFile(): string {
	return join(mkdtempSync(join(tmpdir(), "wa-pi-sp-im-")), "prompts.json");
}

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

test("im-channel 段运行时值优先：段 content 被忽略，不覆盖渠道提示词", () => {
	const segs = DEFAULT_PROMPT_SEGMENTS.map((s) =>
		s.id === "im-channel" ? { ...s, content: "用户手填的内容" } : s,
	);
	const out = composePrompt(segs, {
		...baseCtx,
		imChannelContext: "渠道专属规则",
	});
	expect(out).toContain("渠道专属规则");
	expect(out).not.toContain("用户手填的内容");
});

test("ensureImChannelSegment：缺失时插到 memory-policy 之前；残留 content 被剥掉", () => {
	const segs = [{ id: "base" }, { id: "memory-policy" }, { id: "memory-snapshot" }];
	const withSeg = ensureImChannelSegment(segs as any);
	expect(withSeg.map((s) => s.id)).toEqual([
		"base",
		"im-channel",
		"memory-policy",
		"memory-snapshot",
	]);

	const stripped = ensureImChannelSegment([
		{ id: "im-channel", content: "残留" },
	] as any);
	expect(stripped).toEqual([{ id: "im-channel" }]);
});

test("savePromptSegments 剔除 im-channel 段（不落盘）；loadPromptSegments 原样返回", async () => {
	const f = tempFile();
	try {
		await savePromptSegments(f, [
			{ id: "base" },
			{ id: "im-channel" },
			{ id: "memory-policy" },
		]);
		const raw = JSON.parse(readFileSync(f, "utf8"));
		expect(raw.segments.map((s: any) => s.id)).toEqual(["base", "memory-policy"]);
		const loaded = await loadPromptSegments(f);
		expect(loaded!.map((s) => s.id)).toEqual(["base", "memory-policy"]);
	} finally {
		rmSync(f, { force: true });
	}
});

test("PROMPTS_SCHEMA_VERSION 已升到 25", () => {
	expect(PROMPTS_SCHEMA_VERSION).toBe(25);
});
