// subagent-partial-result.test.ts — 子代理中断时保留部分结果测试
//
// 覆盖三件事：
// 1. 非正常终态路径（中止 / 探活超时 / settle 超时 / 异常）：返回 text 附带「部分进度」段
//   （工具调用数量统计 + 输出片段头尾），且带 interrupted:true 结构化标记（区分「中断」与普通失败）；
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
const { runSubagentAgent, buildPartialProgressNote } = (
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

test("组装函数：统计行格式（只报调用数量，不再逐条列已完成步骤）", () => {
	const tools = [
		{ id: "a", name: "bash", status: "done" },
		{ id: "b", name: "read", status: "error" },
		{ id: "c", name: "write", status: "running" },
	];
	const note = buildPartialProgressNote(tools, "");
	expect(note).toContain("工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	// 步骤列表（工具名 + 状态符号）与「等 N 项」折叠文案均已移除
	expect(note).not.toContain("已完成步骤");
	expect(note).not.toContain("bash ✅");
	expect(note).not.toContain("read ❌");
	expect(note).not.toContain("write ⏸");
	expect(note).not.toContain("等 3 项");
	// 无输出 → 省略「最后输出片段」段
	expect(note).not.toContain("最后输出片段");
});

test("组装函数：工具多时仍只输出统计行（不再拼接长步骤列表）", () => {
	const tools = Array.from({ length: 45 }, (_, i) => ({
		id: String(i),
		name: `t${i}`,
		status: "done",
	}));
	const note = buildPartialProgressNote(tools, "");
	expect(note).toContain("工具调用 45 个（成功 45 / 失败 0 / 中断 0）");
	expect(note).not.toContain("t0 ✅");
	expect(note).not.toContain("等 45 项");
});

test("组装函数：output 超 4000 字符时保留前 1000 + 后 3000（中段省略）", () => {
	const head = "H".repeat(1000);
	const mid = "M".repeat(2000);
	const tail = "T".repeat(3000);
	const note = buildPartialProgressNote([], head + mid + tail); // 共 6000 字符
	expect(note).toContain("最后输出片段");
	expect(note).toContain(head); // 头部 1000 字完整保留
	expect(note).toContain(tail); // 尾部 3000 字完整保留
	expect(note).not.toContain("MMMM"); // 中段被省略
	const seg = note.split("最后输出片段：")[1] ?? "";
	expect(seg.length).toBe(4001); // 1000 + 省略号 + 3000
});

test("组装函数：output 恰 4000 字符不截断", () => {
	const note = buildPartialProgressNote([], "x".repeat(4000));
	const seg = note.split("最后输出片段：")[1] ?? "";
	expect(seg.length).toBe(4000);
	expect(seg).not.toContain("…");
});

test("组装函数：output 未超限时头尾均保留", () => {
	const note = buildPartialProgressNote([], "HEAD-" + "x".repeat(100) + "-TAIL");
	expect(note).toContain("HEAD-");
	expect(note).toContain("-TAIL");
});

test("组装函数：无工具无输出返回空串（调用方不附加段落）", () => {
	expect(buildPartialProgressNote([], "")).toBe("");
});

test("组装函数：不再产出摘录条目（即使工具带 result）", () => {
	const tools: Array<{
		id: string;
		name: string;
		status: string;
		result?: string;
	}> = [
		{ id: "a", name: "bash", status: "done", result: "src/app.ts\n第二行" },
		{ id: "b", name: "read", status: "error", result: "失败详情" },
		{ id: "c", name: "write", status: "running" },
	];
	const note = buildPartialProgressNote(tools, "");
	expect(note).toContain("工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	// 产出摘录（标签行 + 条目）已整体移除
	expect(note).not.toContain("关键产出摘录");
	expect(note).not.toContain("- bash：");
	expect(note).not.toContain("src/app.ts");
	expect(note).not.toContain("第二行");
});

test("组装函数：无 result 时不产出摘录条目且不报错", () => {
	const note = buildPartialProgressNote(
		[
			{ name: "bash", status: "done" },
			{ name: "read", status: "error" },
		],
		"",
	);
	expect(note).toContain("工具调用 2 个（成功 1 / 失败 1 / 中断 0）");
	expect(note).not.toContain("已完成步骤");
	expect(note).not.toContain("关键产出摘录");
	expect(note).not.toContain("- ");
});

// ────────────────────────── 中止 / 超时路径集成 ──────────────────────────

test("中止路径：text 附带部分进度段（统计 + 输出片段）且 interrupted=true", async () => {
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
	// 部分进度段：原因 + 统计 + 输出片段（无摘录条目）
	expect(result.text).toContain("子智能体已被中止");
	expect(result.text).toContain("部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	// 步骤列表与摘录条目均已移除，只有统计行
	expect(result.text).not.toContain("已完成步骤");
	expect(result.text).not.toContain("bash ✅");
	expect(result.text).not.toContain("read ❌");
	expect(result.text).not.toContain("write ⏸");
	expect(result.text).toContain("最后输出片段");
	expect(result.text).toContain("已定位到问题文件");
	// 产出摘录条目不再产出（fixture 的 bash end 事件仍带对象形状 result）
	expect(result.text).not.toContain("关键产出摘录");
	expect(result.text).not.toContain("已定位到入口文件 src/main.ts");
	// toolStats 与分桶一致
	expect(result.toolStats).toEqual({ total: 3, done: 1, error: 1, running: 1 });
}, 10_000);

test("探活超时路径：text 附带部分进度段且 interrupted=true", async () => {
	const result = await runSubagentAgent(baseConfig(), "任务", "/tmp", {
		cliPath: ABORTED_TOOLS_PI,
		runtime: RUNTIME,
		commandTimeoutMs: 60_000, // settle 超时拉长：验证探活先触发
		idleTimeoutMs: 500, // fixture 的 write 停在工具执行中，走工具窗口（独立于基础窗口）
		toolIdleTimeoutMs: 500,
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
	expect(result.text).not.toContain("关键产出摘录");
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
