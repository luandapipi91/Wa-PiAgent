// subagent-partial-result.test.ts — 子代理中断时保留部分结果测试
//
// 覆盖三件事：
// 1. 非正常终态路径（中止 / 探活超时 / settle 超时 / 异常）：返回 text 附带「部分进度」段
//   （工具统计 + 已完成步骤 + 输出片段），且带 interrupted:true 结构化标记（区分「中断」与普通失败）；
// 2. 正常完成路径：text 不含附加段、不标 interrupted；
// 3. 中断标记与 toolStats 全链路透传：spawn 返回值 → makeSpawnFn 遥测输入 →
//    computeSpawnTelemetry 记录 → delegate/fleet execute 的 details（前端可消费）。
//
// 注意：agent-manager-subagent-overrides.test.ts 用 mock.module 全局 mock 了
// "../src/subagent-runner"（进程级生效且无法撤销），本文件用 cache-bust 查询串
// 动态 import 拿真实实现；delegate-tool 侧经 makeSpawnFn 的注入项绕过污染。
import { test, expect, mock } from "bun:test";
import {
	makeDelegateTool,
	makeFleetTool,
	makeSpawnFn,
} from "../src/delegate-tool";
import { computeSpawnTelemetry } from "../src/subagent-telemetry";
import type { SpawnTelemetryInput } from "../src/subagent-telemetry";
import { join } from "node:path";

// cache-bust：绕过 overrides 测试的 mock.module，加载真实 subagent-runner
const REAL_RUNNER_SPEC = "../src/subagent-runner.ts?partial=1";
type RunnerModule = typeof import("../src/subagent-runner");
const { runSubagentAgent, buildPartialProgressNote, retainToolResult } = (
	await import(REAL_RUNNER_SPEC)
) as RunnerModule;

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-pi.ts");
const ABORTED_TOOLS_PI = join(
	import.meta.dir,
	"fixtures",
	"aborted-tools-pi.ts",
);
const RUNTIME = process.execPath;

const askTo = [
	{ name: "代码审查", description: "评审改动" },
	{ name: "质量验收", description: "测试与验收" },
];

function baseConfig() {
	return {
		name: "research",
		description: "调研",
		systemPrompt: "你是一个调研员",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	};
}

function makeInput(
	overrides: Partial<SpawnTelemetryInput> = {},
): SpawnTelemetryInput {
	return {
		agent: "Explore",
		task: "找出所有调用 X 的地方",
		isError: false,
		returnText: "结论：共 3 处调用。",
		elapsedMs: 1234,
		...overrides,
	};
}

// ────────────────────────── 组装函数单测 ──────────────────────────

test("组装函数：工具统计与步骤列表格式（无目标描述只列工具名）", () => {
	const tools = [
		{ id: "a", name: "bash", status: "done" },
		{ id: "b", name: "read", status: "error" },
		{ id: "c", name: "write", status: "running" },
	];
	const note = buildPartialProgressNote(tools, "");
	expect(note).toContain("工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	expect(note).toContain("bash ✅");
	expect(note).toContain("read ❌");
	expect(note).toContain("write ⏸");
	// 无输出 → 省略「最后输出片段」段
	expect(note).not.toContain("最后输出片段");
});

test("组装函数：步骤超过 30 条折叠为「等 N 项」", () => {
	const tools = Array.from({ length: 45 }, (_, i) => ({
		id: String(i),
		name: `t${i}`,
		status: "done",
	}));
	const note = buildPartialProgressNote(tools, "");
	expect(note).toContain("工具调用 45 个（成功 45 / 失败 0 / 中断 0）");
	expect(note).toContain("t29 ✅"); // 前 30 条列出
	expect(note).not.toContain("t30 ✅"); // 第 31 条起折叠
	expect(note).toContain("等 45 项");
});

test("组装函数：output 截断到 4000 字符且取尾部", () => {
	const output = "HEAD-" + "x".repeat(6000) + "-TAIL";
	const note = buildPartialProgressNote([], output);
	expect(note).toContain("最后输出片段");
	expect(note).not.toContain("HEAD-"); // 头部截掉
	expect(note).toContain("-TAIL"); // 保留尾部
	// 片段总长 ≤ 4001（4000 + 截断省略号）
	const seg = note.split("最后输出片段：")[1] ?? "";
	expect(seg.length).toBeLessThanOrEqual(4001);
});

test("组装函数：无工具无输出返回空串（调用方不附加段落）", () => {
	expect(buildPartialProgressNote([], "")).toBe("");
});

test("组装函数：done 工具的 result 进「关键产出摘录」段（仅 done、首行、最多 10 条）", () => {
	const tools: Array<{
		id: string;
		name: string;
		status: string;
		result?: string;
	}> = [
		{ id: "a", name: "bash", status: "done", result: "src/app.ts\n第二行" },
		{ id: "b", name: "read", status: "error", result: "失败详情不应进摘录" },
		{ id: "c", name: "write", status: "running" },
	];
	// 再补 10 个 done：bash + 10 = 11 条，验证只取前 10 条
	for (let i = 0; i < 10; i++) {
		tools.push({
			id: `x${i}`,
			name: `t${i}`,
			status: "done",
			result: `产出${i}`,
		});
	}
	const note = buildPartialProgressNote(tools, "");
	expect(note).toContain("关键产出摘录：");
	expect(note).toContain("- bash：src/app.ts"); // 只取首行
	expect(note).not.toContain("第二行");
	expect(note).not.toContain("失败详情不应进摘录"); // error 工具不进摘录
	expect(note).toContain("- t8：产出8"); // 第 10 条 done（bash 之后第 9 个）
	expect(note).not.toContain("- t9：产出9"); // 第 11 条 done 被截掉
	expect(note).not.toContain("- write："); // running 无 result
});

test("组装函数：摘录首行超 200 字符截断加省略号", () => {
	const tools = [
		{ id: "a", name: "bash", status: "done", result: "长".repeat(300) + "-TAIL" },
	];
	const note = buildPartialProgressNote(tools, "");
	const seg = note.split("- bash：")[1]?.split("\n")[0] ?? "";
	expect(seg.length).toBe(201); // 200 + 省略号
	expect(seg.endsWith("…")).toBe(true);
	expect(seg.endsWith("-TAIL")).toBe(false);
});

test("组装函数：无 result 时无摘录段不报错", () => {
	const note = buildPartialProgressNote(
		[
			{ name: "bash", status: "done" },
			{ name: "read", status: "error" },
		],
		"",
	);
	expect(note).toContain("已完成步骤");
	expect(note).not.toContain("关键产出摘录");
});

test("retainToolResult：单条超 800 字符截断，恰 800 不截", () => {
	const tools: Array<{
		id: string;
		name: string;
		status: string;
		result?: string;
	}> = [{ id: "a", name: "bash", status: "done" }];
	retainToolResult(tools, "a", "x".repeat(801) + "-TAIL");
	expect(tools[0].result).toBeDefined();
	expect(tools[0].result!.length).toBe(800);
	expect(tools[0].result!.endsWith("-TAIL")).toBe(false);
	// 恰好等于上限不截断
	retainToolResult(tools, "a", "y".repeat(800));
	expect(tools[0].result!.length).toBe(800);
});

test("retainToolResult：总量超 16KB 从最旧丢弃", () => {
	const tools: Array<{
		id: string;
		name: string;
		status: string;
		result?: string;
	}> = Array.from({ length: 21 }, (_, i) => ({
		id: String(i),
		name: `t${i}`,
		status: "done",
	}));
	// 21 × 800 = 16800 > 16384：丢 1 条最旧后 16000 ≤ 16384
	for (let i = 0; i < 21; i++) {
		retainToolResult(tools, String(i), "z".repeat(800));
	}
	const kept = tools.filter((t) => t.result);
	expect(kept.length).toBe(20);
	expect(tools[0].result).toBeUndefined();
	expect(tools[20].result).toBeDefined();
});

// ────────────────────────── 中止 / 超时路径集成 ──────────────────────────

test("中止路径：text 附带部分进度段（统计 + 步骤 + 输出片段）且 interrupted=true", async () => {
	const ctrl = new AbortController();
	const resultP = runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: ABORTED_TOOLS_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长：验证 abort 短路先触发
		abortGraceMs: 300,
		signal: ctrl.signal,
	});
	// 等 fixture 发完工具事件（同步发出，进程启动后立即可见）
	await new Promise((r) => setTimeout(r, 400));
	ctrl.abort();
	const result = await resultP;
	expect(result.isError).toBe(true);
	// 结构化中断标记
	expect(result.interrupted).toBe(true);
	// 部分进度段：原因 + 统计 + 步骤 + 输出片段
	expect(result.text).toContain("子智能体已被中止");
	expect(result.text).toContain("部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	expect(result.text).toContain("bash ✅");
	expect(result.text).toContain("read ❌");
	expect(result.text).toContain("write ⏸");
	expect(result.text).toContain("最后输出片段");
	expect(result.text).toContain("已定位到问题文件");
	// 关键产出摘录：fixture 工具 1（bash 成功）end 事件携带对象形状 result
	expect(result.text).toContain("关键产出摘录");
	expect(result.text).toContain("- bash：已定位到入口文件 src/main.ts");
	// toolStats 与分桶一致
	expect(result.toolStats).toEqual({ total: 3, done: 1, error: 1, running: 1 });
}, 10_000);

test("探活超时路径：text 附带部分进度段且 interrupted=true", async () => {
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: ABORTED_TOOLS_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长：验证探活先触发
		idleTimeoutMs: 500,
	});
	expect(result.isError).toBe(true);
	expect(result.interrupted).toBe(true);
	expect(result.text).toContain("无进展");
	expect(result.text).toContain("部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	expect(result.text).toContain("最后输出片段");
}, 10_000);

// ────────────────────────── 正常完成路径 ──────────────────────────

test("正常完成路径：text 不含附加段且不标 interrupted", async () => {
	const result = await runSubagentAgent(baseConfig(), "测试任务", "/tmp", {
		cliPath: FAKE_PI,
		runtime: RUNTIME,
	});
	expect(result.isError).toBe(false);
	expect(result.interrupted).toBeUndefined();
	expect(result.text).toContain("回声:测试任务");
	expect(result.text).not.toContain("部分进度");
	expect(result.text).not.toContain("已完成步骤");
	expect(result.text).not.toContain("最后输出片段");
});

// ────────────────────────── 链路透传（spawn → 遥测 / details） ──────────────────────────

test("makeSpawnFn：spawn 结果的 interrupted/toolStats 透传到返回值与遥测输入", async () => {
	const inputs: SpawnTelemetryInput[] = [];
	const spawnFn = makeSpawnFn({
		resolveConfig: async () => baseConfig(),
		cwd: "/tmp",
		onSpawnComplete: (input) => inputs.push(input),
		runSubagentAgent: (async () => ({
			text: "子智能体已被中止。部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）",
			isError: true,
			interrupted: true,
			toolStats: { total: 3, done: 1, error: 1, running: 1 },
			elapsedMs: 123,
		})) as any,
	});
	const r = await spawnFn("Explore", "任务", "tc-t");
	expect(r.interrupted).toBe(true);
	expect(inputs).toHaveLength(1);
	expect(inputs[0].interrupted).toBe(true);
	expect(inputs[0].toolStats).toEqual({ total: 3, done: 1, error: 1, running: 1 });
});

test("delegate execute：interrupted 写入 details（isError 语义不变）", async () => {
	const spawn = mock(async () => ({
		text: "子智能体已被中止。部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）",
		isError: true,
		interrupted: true,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-d", { agent: "代码审查", task: "hi" });
	expect(res.isError).toBe(true);
	expect((res.details as any)?.interrupted).toBe(true);
});

test("fleet execute：details.fleet 保持 ToolStats 形状，interrupted 按任务序号记录", async () => {
	const spawn = mock(
		async (
			_agent: string,
			_task: string,
			_tc: string,
			index?: number,
		): Promise<any> =>
			index === 0
				? {
						text: "子智能体已被中止。部分进度：…",
						isError: true,
						interrupted: true,
						toolStats: { total: 3, done: 1, error: 1, running: 1 },
					}
				: {
						text: "完成",
						isError: false,
						toolStats: { total: 1, done: 1, error: 0, running: 0 },
					},
	);
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-f", {
		tasks: [
			{ agent: "代码审查", task: "a" },
			{ agent: "质量验收", task: "b" },
		],
	});
	const details = res.details as any;
	// 现有 fleet 统计形状不变（前端兼容）
	expect(details.fleet["0"]).toEqual({ total: 3, done: 1, error: 1, running: 1 });
	expect(details.fleet["1"]).toEqual({ total: 1, done: 1, error: 0, running: 0 });
	// 新增：按任务序号的中断标记
	expect(details.interrupted["0"]).toBe(true);
	expect(details.interrupted["1"]).toBe(false);
});

test("computeSpawnTelemetry：记录 interrupted 与 toolStats（中断派发）", () => {
	const rec = computeSpawnTelemetry(
		makeInput({
			isError: true,
			interrupted: true,
			toolStats: { total: 3, done: 1, error: 1, running: 1 },
		}),
	);
	expect(rec.interrupted).toBe(true);
	expect(rec.toolStats).toEqual({ total: 3, done: 1, error: 1, running: 1 });
});

test("computeSpawnTelemetry：正常完成 interrupted=false 且 toolStats 透传", () => {
	const rec = computeSpawnTelemetry(
		makeInput({
			toolStats: { total: 5, done: 5, error: 0, running: 0 },
		}),
	);
	expect(rec.interrupted).toBe(false);
	expect(rec.toolStats).toEqual({ total: 5, done: 5, error: 0, running: 0 });
});
