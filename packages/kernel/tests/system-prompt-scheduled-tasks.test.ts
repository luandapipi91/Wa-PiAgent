import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composePrompt,
	DEFAULT_PROMPT_SEGMENTS,
	ensureScheduledTasksSegment,
	loadPromptSegments,
	savePromptSegments,
} from "../src/system-prompt";

// 本测试只关心 scheduled-tasks 段的显隐与位置，其余动态段给空值即可
const baseCtx: any = {
	defaultBasePrompt: "",
	builtinSkillsDir: "/tmp/skills",
	delegateRoster: "",
	memoryPolicy: "记忆策略",
	memorySnapshot: "",
	imChannelContext: undefined,
	imPushContext: undefined,
};
// scheduled-tasks 段：全局化后始终直接注入（不再依赖 ctx.scheduledTasksDir）

function tempFile(): string {
	return join(mkdtempSync(join(tmpdir(), "wa-pi-sp-st-")), "prompts.json");
}

test("scheduled-tasks 段：始终注入引导文案（不再判目录存在）", () => {
	const prompt = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
		defaultBasePrompt: "base",
		builtinSkillsDir: "/skills",
	});
	expect(prompt).toContain("scheduled-tasks");
	expect(prompt).toContain("README.md");
	expect(prompt).toContain(".pi/agent/scheduled-tasks");
	// 约束：所有定时任务操作必须通过 CLI，不能直接编辑目录文件
	expect(prompt).toContain("必须通过");
	expect(prompt).toContain("cron-task.ts");
	expect(prompt).toContain("禁止直接编辑");
});

test("ensureScheduledTasksSegment：缺失时插到 memory-policy 之前；残留 content 被剥掉", () => {
	const segs = [
		{ id: "base" },
		{ id: "memory-policy" },
		{ id: "memory-snapshot" },
	];
	const withSeg = ensureScheduledTasksSegment(segs as any);
	expect(withSeg.map((s) => s.id)).toEqual([
		"base",
		"scheduled-tasks",
		"memory-policy",
		"memory-snapshot",
	]);

	const stripped = ensureScheduledTasksSegment([
		{ id: "scheduled-tasks", content: "残留" },
	] as any);
	expect(stripped).toEqual([{ id: "scheduled-tasks" }]);
});

test("savePromptSegments 剔除 scheduled-tasks 段（不落盘）；loadPromptSegments 原样返回", async () => {
	const f = tempFile();
	try {
		await savePromptSegments(f, [
			{ id: "base" },
			{ id: "scheduled-tasks" },
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
