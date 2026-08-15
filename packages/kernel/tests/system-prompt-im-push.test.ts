import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composePrompt,
	DEFAULT_PROMPT_SEGMENTS,
	ensureImPushSegment,
	loadPromptSegments,
	savePromptSegments,
} from "../src/system-prompt";

// 本测试只关心段序与 im-push 段的显隐，其余动态段给空值即可
const baseCtx: any = {
	defaultBasePrompt: "",
	builtinSkillsDir: "/tmp/skills",
	delegateRoster: "",
	memoryPolicy: "记忆策略",
	memorySnapshot: "",
	imChannelContext: undefined,
	imPushContext: undefined,
};

function tempFile(): string {
	return join(mkdtempSync(join(tmpdir(), "wa-pi-sp-impush-")), "prompts.json");
}

test("im-push 段位于 im-channel 之后、memory-policy 之前", () => {
	const ids = DEFAULT_PROMPT_SEGMENTS.map((s) => s.id);
	const ch = ids.indexOf("im-channel");
	const push = ids.indexOf("im-push");
	const mem = ids.indexOf("memory-policy");
	expect(push).toBeGreaterThan(ch);
	expect(push).toBeLessThan(mem);
});

test("imPushContext 为空 → 段不出现；有内容 → 出现在 memory-policy 之前", () => {
	const without = composePrompt(DEFAULT_PROMPT_SEGMENTS, baseCtx);
	expect(without).not.toContain("推送目标联系人");

	const withCtx = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
		...baseCtx,
		imPushContext: "推送目标联系人：ct_p01",
	});
	expect(withCtx).toContain("推送目标联系人：ct_p01");
	expect(withCtx.indexOf("推送目标联系人")).toBeLessThan(
		withCtx.indexOf("记忆策略"),
	);
});

test("im-push 段运行时值优先：段 content 被忽略，不覆盖推送引导", () => {
	const segs = DEFAULT_PROMPT_SEGMENTS.map((s) =>
		s.id === "im-push" ? { ...s, content: "用户手填的内容" } : s,
	);
	const out = composePrompt(segs, {
		...baseCtx,
		imPushContext: "推送目标联系人",
	});
	expect(out).toContain("推送目标联系人");
	expect(out).not.toContain("用户手填的内容");
});

test("ensureImPushSegment：缺失时插到 memory-policy 之前；残留 content 被剥掉", () => {
	const segs = [{ id: "base" }, { id: "memory-policy" }, { id: "memory-snapshot" }];
	const withSeg = ensureImPushSegment(segs as any);
	expect(withSeg.map((s) => s.id)).toEqual([
		"base",
		"im-push",
		"memory-policy",
		"memory-snapshot",
	]);

	const stripped = ensureImPushSegment([
		{ id: "im-push", content: "残留" },
	] as any);
	expect(stripped).toEqual([{ id: "im-push" }]);
});

test("savePromptSegments 剔除 im-push 段（不落盘）；loadPromptSegments 原样返回", async () => {
	const f = tempFile();
	try {
		await savePromptSegments(f, [
			{ id: "base" },
			{ id: "im-push" },
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
