// delegate 关系网调起工具单测：
// - makeDelegateTool：allowlist 校验（越权不 spawn）+ spawn 结果透传 + 工具描述纯功能
// - buildDelegateRoster：可用子智能体总览段（内置+命名统一列表）
// - makeFleetTool：并行派发 + 聚合
// - makeSpawnFn：spawn 闭包工厂（resolveConfig → runSubagentAgent）
import { test, expect, mock } from "bun:test";
import {
	makeDelegateTool,
	makeFleetTool,
	buildDelegateRoster,
	makeSpawnFn,
	MAX_SUBAGENT_CONCURRENCY,
} from "../src/delegate-tool";
import type { SpawnTelemetryInput } from "../src/subagent-telemetry";
import { join } from "node:path";

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-pi.ts");

// cache-bust：agent-manager-subagent-overrides.test.ts 用 mock.module 全局 mock 了
// "../src/subagent-runner"（bun 的 mock.module 进程级生效且无法撤销）。
// makeSpawnFn 内部 import 的 runSubagentAgent 会命中该 mock，导致真实跑通用例失效。
// 这里用查询串动态 import 拿真实实现，经 makeSpawnFn 的注入项传入以绕过污染。
const REAL_RUNNER_SPEC = "../src/subagent-runner.ts?real=1";
type RunnerModule = typeof import("../src/subagent-runner");
const { runSubagentAgent: realRunSubagentAgent } = (await import(
	REAL_RUNNER_SPEC
)) as RunnerModule;

const askTo = [
	{ name: "代码审查", description: "评审改动" },
	{ name: "质量验收", description: "测试与验收" },
];

test("delegate: 越权调起返回错误且不 spawn", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc1", { agent: "陌生人", task: "hi" });
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("不在可调起列表");
	expect(res.content[0].text).toContain("代码审查、质量验收");
	expect(spawn).not.toHaveBeenCalled();
});

test("delegate: 合法调起透传结果", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}完成:${task}`,
		isError: false,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc2", {
		agent: "代码审查",
		task: "review diff",
	});
	expect(res.isError).toBe(false);
	expect(res.content[0].text).toBe("代码审查完成:review diff");
	// toolCallId 透传给 spawn（第三个参数）
	expect(spawn).toHaveBeenCalledWith("代码审查", "review diff", "tc2");
});

test("delegate: 透传 spawn 的失败结果（isError 原样带出）", async () => {
	const spawn = mock(async () => ({ text: "子智能体执行失败", isError: true }));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc3", { agent: "质量验收", task: "跑测试" });
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toBe("子智能体执行失败");
});

test("buildDelegateRoster: 紧凑列表格式（一行一智能体，无 XML 标签）", () => {
	const r = buildDelegateRoster([], {}, "/agents");
	expect(r).toContain("## Available Subagents");
	expect(r).toContain("- Explore：");
	expect(r).toContain("- Plan：");
	expect(r).toContain("- general-purpose：");
	expect(r).not.toContain("<subagents>");
	expect(r).not.toContain("<agent>");
});

test("buildDelegateRoster: 不再输出定义文件路径（元数据瘦身）", () => {
	const r = buildDelegateRoster([], {}, "/agents");
	expect(r).not.toContain("<location>");
	expect(r).not.toContain("/agents/Explore.md");
});

test("buildDelegateRoster: 内置类型 hints 内联在行内", () => {
	const r = buildDelegateRoster(
		[],
		{
			Explore: {
				whenToDelegate: "跨多文件探索",
				whenNotTo: "needle query",
				benefit: "省上下文",
			},
		},
		"/agents",
	);
	expect(r).toContain("- Explore：");
	expect(r).toContain("何时派：跨多文件探索");
	expect(r).toContain("不派：needle query");
	expect(r).toContain("收益：省上下文");
	expect(r).not.toContain("<whenToDelegate>");
});

test("buildDelegateRoster: 命名智能体与内置类型统一列表（格式一致）", () => {
	const r = buildDelegateRoster(
		[
			{
				name: "代码审查",
				description: "评审改动",
				delegationHints: {
					whenToDelegate: "代码需评审",
					benefit: "结构化反馈",
				},
			},
		],
		{},
		"/agents",
	);
	expect(r).toContain("- 代码审查：评审改动；何时派：代码需评审；收益：结构化反馈");
	// 内置类型也在（统一列表，不分类）
	expect(r).toContain("- Explore：");
});

test("buildDelegateRoster: 无 hints 的命名智能体只给名称+简介", () => {
	const r = buildDelegateRoster(
		[{ name: "测试员", description: "写测试", delegationHints: undefined }],
		{},
		"/agents",
	);
	expect(r).toContain("- 测试员：写测试");
	// 无 hints 时不应出现委派提示字段
	expect(r).not.toContain("何时派：");
});

test("makeDelegateTool 描述为纯功能说明（不含智能体列表/hints）", () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeDelegateTool({ askTo, spawn });
	// 不含具体智能体信息（已移到系统提示词）
	expect(tool.description).not.toContain("Explore");
	expect(tool.description).not.toContain("代码审查");
	expect(tool.description).not.toContain("何时委派");
});

// ---- 内置 subagent 类型名（general-purpose / Explore / Plan）allowlist 放行 ----

test("delegate: 内置类型名 general-purpose 放行（绕过 askTo 名单）", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}:${task}`,
		isError: false,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-gp", {
		agent: "general-purpose",
		task: "do something",
	});
	expect(res.isError).toBe(false);
	expect(res.content[0].text).toBe("general-purpose:do something");
	expect(spawn).toHaveBeenCalledWith("general-purpose", "do something", "tc-gp");
});

test("delegate: 内置类型名 Explore 放行（大小写敏感）", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}:${task}`,
		isError: false,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-ex", {
		agent: "Explore",
		task: "search code",
	});
	expect(res.isError).toBe(false);
	expect(spawn).toHaveBeenCalledWith("Explore", "search code", "tc-ex");
});

test("delegate: 内置类型名 Plan 放行（绕过 askTo 名单）", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}:${task}`,
		isError: false,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-plan", {
		agent: "Plan",
		task: "design plan",
	});
	expect(res.isError).toBe(false);
	expect(spawn).toHaveBeenCalledWith("Plan", "design plan", "tc-plan");
});

test("delegate: 大小写错误（explore 而非 Explore）不放行", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-lower", { agent: "explore", task: "x" });
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("不在可调起列表");
	expect(spawn).not.toHaveBeenCalled();
});

test("delegate: 错误信息列出可调起名单 + 内置类型", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-err", { agent: "陌生人", task: "x" });
	expect(res.content[0].text).toContain("代码审查");
	expect(res.content[0].text).toContain("质量验收");
	expect(res.content[0].text).toContain("general-purpose");
	expect(res.content[0].text).toContain("Explore");
});

test("delegate: 中文别名（通用子智能体）放行并归一化为英文 name 传给 spawn", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}:${task}`,
		isError: false,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-cn", {
		agent: "通用子智能体",
		task: "做某事",
	});
	expect(res.isError).toBe(false);
	expect(spawn).toHaveBeenCalledWith("general-purpose", "做某事", "tc-cn");
});

test("delegate: 中文别名（探索子智能体）归一化为 Explore", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}:${task}`,
		isError: false,
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-cn-ex", {
		agent: "探索子智能体",
		task: "搜代码",
	});
	expect(res.isError).toBe(false);
	expect(spawn).toHaveBeenCalledWith("Explore", "搜代码", "tc-cn-ex");
});

test("fleet: 内置类型名也放行（每个 task 独立校验）", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `${agent}:${task}`,
		isError: false,
	}));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-fleet", {
		tasks: [
			{ agent: "Explore", task: "search A" },
			{ agent: "代码审查", task: "review B" },
			{ agent: "general-purpose", task: "general task" },
		],
	});
	expect(res.isError).toBe(false);
	expect(res.content[0].text).toContain("Explore:search A");
	expect(res.content[0].text).toContain("代码审查:review B");
	expect(res.content[0].text).toContain("general-purpose:general task");
	expect(spawn).toHaveBeenCalledTimes(3);
});

test("fleet: 内置类型 + 越权 agent 混合时越权项报错但其它项正常", async () => {
	const spawn = mock(async (agent: string, _task: string) => ({
		text: `${agent}:ok`,
		isError: false,
	}));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-fleet-mix", {
		tasks: [
			{ agent: "Explore", task: "search" },
			{ agent: "陌生人", task: "x" },
		],
	});
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("Explore:ok");
	expect(res.content[0].text).toContain("陌生人");
	expect(res.content[0].text).toContain("不在可调起列表");
	expect(spawn).toHaveBeenCalledTimes(1);
});

test("fleet: 并发执行多个合法任务，结果按输入顺序聚合", async () => {
	const spawn = mock(async (agent: string, task: string) => ({
		text: `[${agent}] done: ${task}`,
		isError: false,
	}));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc4", {
		tasks: [
			{ agent: "代码审查", task: "review a" },
			{ agent: "质量验收", task: "test b" },
		],
	});
	expect(res.isError).toBe(false);
	expect(res.content[0].text).toContain("[代码审查] done: review a");
	expect(res.content[0].text).toContain("[质量验收] done: test b");
	expect(spawn).toHaveBeenCalledTimes(2);
});

test("fleet: 单个任务失败不影响其他任务，聚合标记 isError", async () => {
	const spawn = mock(async (agent: string, _task: string) => {
		if (agent === "代码审查") return { text: "评审通过", isError: false };
		return { text: "测试失败", isError: true };
	});
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc5", {
		tasks: [
			{ agent: "代码审查", task: "review" },
			{ agent: "质量验收", task: "test" },
		],
	});
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("评审通过");
	expect(res.content[0].text).toContain("测试失败");
});

test("fleet: 越权 agent 跳过 spawn，单项返回错误文本", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeFleetTool({ askTo, spawn });
	// 两个任务：单任务 fleet 已被 execute 前置拒绝，走不到 allowlist 分支
	const res = await tool.execute("tc6", {
		tasks: [
			{ agent: "陌生人", task: "x" },
			{ agent: "陌生人2", task: "y" },
		],
	});
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("不在可调起列表");
	expect(spawn).not.toHaveBeenCalled();
});

test("fleet: 空任务数组返回提示文本", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc7", { tasks: [] });
	expect(res.isError).toBe(false);
	expect(res.content[0].text).toContain("无任务");
});

test("fleet: 仅 1 个任务时拒绝执行，提示改用 delegate", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc8", {
		tasks: [{ agent: "代码审查", task: "review" }],
	});
	expect(res.isError).toBe(true);
	// 文案要点：并行委派需 2 个以上任务 + 指向 delegate 单任务委派
	expect(res.content[0].text).toContain("delegate");
	expect(res.content[0].text).toContain("2");
	expect(res.details).toEqual({ error: "fleet_requires_multiple_tasks" });
	// 拒绝在派发前发生：不得启动任何子智能体
	expect(spawn).not.toHaveBeenCalled();
});

test("fleet: 聚合各子代理 toolStats 到 details.fleet（完成态持久化统计）", async () => {
	const spawn = mock(async (agent: string) => ({
		text: `[${agent}] done`,
		isError: false,
		toolStats:
			agent === "代码审查"
				? { total: 3, done: 2, error: 1, running: 0 }
				: { total: 1, done: 1, error: 0, running: 0 },
	}));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-stats", {
		tasks: [
			{ agent: "代码审查", task: "review" },
			{ agent: "质量验收", task: "test" },
		],
	});
	expect(res.isError).toBe(false);
	// 新契约：details 新增按序号的中断标记（无中断时全 false）
	expect(res.details).toEqual({
		fleet: {
			"0": { total: 3, done: 2, error: 1, running: 0 },
			"1": { total: 1, done: 1, error: 0, running: 0 },
		},
		interrupted: { "0": false, "1": false },
	});
});

// ---- makeSpawnFn 测试 ----

test("makeSpawnFn: resolveConfig 返回 null → 错误文本", async () => {
	const resolveConfig = mock(async () => null);
	const spawn = makeSpawnFn({ resolveConfig, cwd: "/tmp" });
	const result = await spawn("unknown-agent", "task", "tc-null");
	expect(result.isError).toBe(true);
	expect(result.text).toContain("配置未找到");
	expect(result.text).toContain("unknown-agent");
});

test("makeSpawnFn: resolveConfig 成功 → 经 fake-pi 确定性跑通并回传结果", async () => {
	const resolveConfig = mock(async () => ({
		name: "test-agent",
		description: "test desc",
		systemPrompt: "you are a test agent",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	}));
	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: "/tmp",
		runnerOpts: { cliPath: FAKE_PI, runtime: process.execPath },
		runSubagentAgent: realRunSubagentAgent,
	});
	const result = await spawn("test-agent", "task", "tc-ok");
	expect(resolveConfig).toHaveBeenCalledWith("test-agent");
	expect(result.isError).toBe(false);
	expect(result.text).toContain("回声:task");
	// fake-pi 支持 get_session_stats → usage 透传
	expect(result.usage?.tokens.output).toBe(250);
});

test("makeSpawnFn: onProgress 回调正确绑定", async () => {
	const progressEvents: any[] = [];
	const receivedToolCallIds: string[] = [];
	// onProgress 新签名：(toolCallId, event)
	const onProgress = mock((tcId: string, event: any) => {
		receivedToolCallIds.push(tcId);
		progressEvents.push(event);
	});
	const resolveConfig = mock(async () => ({
		name: "test-agent",
		description: "test desc",
		systemPrompt: "you are a test agent",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	}));
	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: "/tmp",
		onProgress,
		runnerOpts: { cliPath: FAKE_PI, runtime: process.execPath },
		runSubagentAgent: realRunSubagentAgent,
	});
	await spawn("test-agent", "task", "tc-prog");
	// fake-pi 有 text_delta → 至少一个 running 事件，结尾一个 done
	expect(progressEvents.some((e) => e.status === "running")).toBe(true);
	expect(progressEvents.at(-1)?.status).toBe("done");
	// 所有进度帧都带上同一个 toolCallId
	expect(receivedToolCallIds.every((id) => id === "tc-prog")).toBe(true);
	expect(receivedToolCallIds.length).toBeGreaterThan(0);
});

test("MAX_SUBAGENT_CONCURRENCY 为 6（控制内存：6 子代理 × ~300MB 约 1.8GB，可接受）", () => {
	expect(MAX_SUBAGENT_CONCURRENCY).toBe(6);
});

test("makeFleetTool 渲染后的描述包含真实并发数（防文案/数值脱节回归）", () => {
	const spawn = async () => ({ text: "", isError: false });
	const fleet = makeFleetTool({ askTo: [], spawn });
	expect(fleet.description).toContain(`并发上限 ${MAX_SUBAGENT_CONCURRENCY}`);
	expect(fleet.description).not.toContain("Concurrency limit is 5");
	expect(fleet.description).not.toContain("Concurrency limit is 6");
});

// ---- onSpawnComplete 遥测回调 ----

test("makeSpawnFn: resolveConfig 为 null 时 onSpawnComplete 记录失败派发", async () => {
	const resolveConfig = mock(async () => null);
	const onSpawnComplete = mock((_input: SpawnTelemetryInput) => {});
	const spawn = makeSpawnFn({ resolveConfig, cwd: "/tmp", onSpawnComplete });
	await spawn("unknown-agent", "任务X", "tc-telemetry");
	expect(onSpawnComplete).toHaveBeenCalledTimes(1);
	const input = onSpawnComplete.mock.calls[0]![0]!;
	expect(input.agent).toBe("unknown-agent");
	expect(input.task).toBe("任务X");
	expect(input.isError).toBe(true);
	expect(input.returnText).toContain("配置未找到");
});

// ---- provider-extension 自愈：派发前确保子智能体所需的 provider slug 已被 extension 覆盖 ----

test("makeSpawnFn: model 含 provider slug 时派发前调用 ensureExtension(slug) 自愈", async () => {
	const resolveConfig = mock(async () => ({
		name: "test-agent",
		description: "test desc",
		systemPrompt: "you are a test agent",
		// 形如 provider/model，/ 前为子智能体所需 provider slug
		model: "deepseek/deepseek-v4-pro",
		thinking: null,
		tools: [],
		skills: [],
	}));
	const ensureExtension = mock(async (_slug?: string) => {});
	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: "/tmp",
		ensureExtension,
		runnerOpts: { cliPath: FAKE_PI, runtime: process.execPath },
		runSubagentAgent: realRunSubagentAgent,
	});
	await spawn("test-agent", "task", "tc-slug");
	expect(ensureExtension).toHaveBeenCalledTimes(1);
	// 传入的 slug 应从 model 解析出 deepseek
	expect(ensureExtension).toHaveBeenCalledWith("deepseek");
});

test("makeSpawnFn: model 为 null（跟随主模型）时 ensureExtension 以 undefined 调用", async () => {
	const resolveConfig = mock(async () => ({
		name: "test-agent",
		description: "test desc",
		systemPrompt: "you are a test agent",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	}));
	const ensureExtension = mock(async (_slug?: string) => {});
	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: "/tmp",
		ensureExtension,
		runnerOpts: { cliPath: FAKE_PI, runtime: process.execPath },
		runSubagentAgent: realRunSubagentAgent,
	});
	await spawn("test-agent", "task", "tc-null-model");
	expect(ensureExtension).toHaveBeenCalledTimes(1);
	// 无具体 slug 时仍调用（让 agent-manager 决定是否重生），但参数为 undefined
	expect(ensureExtension).toHaveBeenCalledWith(undefined);
});

test("makeSpawnFn: 未注入 ensureExtension 时不报错（向后兼容）", async () => {
	const resolveConfig = mock(async () => ({
		name: "test-agent",
		description: "test desc",
		systemPrompt: "you are a test agent",
		model: "deepseek/deepseek-v4-pro",
		thinking: null,
		tools: [],
		skills: [],
	}));
	// 不传 ensureExtension：不应抛错，应正常派发
	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: "/tmp",
		runnerOpts: { cliPath: FAKE_PI, runtime: process.execPath },
		runSubagentAgent: realRunSubagentAgent,
	});
	const result = await spawn("test-agent", "task", "tc-noext");
	expect(result.isError).toBe(false);
});

// ---- Task 3: toolCallId 透传到 spawn 与 onProgress（前端 DelegateCard 靠它定位卡片）----

test("makeSpawnFn 的 onProgress 回调能收到 toolCallId", async () => {
	const toolCallId = "tc-test-001";
	const received: Array<{ tcId: string; agent: string }> = [];
	const spawnFn = makeSpawnFn({
		resolveConfig: async () => ({
			name: "test-agent",
			description: "",
			systemPrompt: "",
			model: null,
			thinking: null,
			tools: [],
			skills: [],
		}),
		cwd: "/tmp",
		// 注入假的 runSubagentAgent：立即触发一次 onProgress 再返回
		runSubagentAgent: (async (
			_config: any,
			_task: string,
			_cwd: string,
			opts: any,
		) => {
			opts?.onProgress?.({
				agent: "test-agent",
				status: "running",
				output: "hi",
				tools: [],
				elapsedMs: 1,
			});
			return { text: "done", isError: false, elapsedMs: 1 };
		}) as any,
		onProgress: (tcId, event) => received.push({ tcId, agent: event.agent }),
	});
	// spawnFn 现在接受第三个参数 toolCallId
	await spawnFn("test-agent", "do something", toolCallId);
	expect(received).toEqual([{ tcId: toolCallId, agent: "test-agent" }]);
});

test("makeDelegateTool execute 把 toolCallId 透传给 spawn", async () => {
	let spawnCalledWith: string | undefined;
	const tool = makeDelegateTool({
		askTo: [],
		spawn: async (_agent, _task, toolCallId) => {
			spawnCalledWith = toolCallId;
			return { text: "ok", isError: false };
		},
	});
	await tool.execute("tc-xyz", { agent: "general-purpose", task: "hi" });
	expect(spawnCalledWith).toBe("tc-xyz");
});

test("delegate: 子代理 usage 转 pi toolResult.usage 形状（官方 stats 原生计入累计）", async () => {
	const spawn = mock(async () => ({
		text: "完成",
		isError: false,
		usage: {
			tokens: {
				input: 300,
				output: 130,
				cacheRead: 1000,
				cacheWrite: 0,
				total: 1430,
			},
			costTotal: 0.01,
		},
	}));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-u1", { agent: "代码审查", task: "t" });
	// pi addUsageToTotals 直接读 input/output/cacheRead/cacheWrite/cost.total，全部为数
	expect(res.usage).toEqual({
		input: 300,
		output: 130,
		cacheRead: 1000,
		cacheWrite: 0,
		totalTokens: 1430,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	});
});

test("delegate: 无 usage（采集失败降级）时不带 usage 字段", async () => {
	const spawn = mock(async () => ({ text: "完成", isError: false }));
	const tool = makeDelegateTool({ askTo, spawn });
	const res = await tool.execute("tc-u2", { agent: "代码审查", task: "t" });
	expect(res.usage).toBeUndefined();
});

test("fleet: 各子代理 usage 聚合为单个 toolResult.usage", async () => {
	const usageOf = (input: number) => ({
		tokens: {
			input,
			output: 10,
			cacheRead: 100,
			cacheWrite: 0,
			total: input + 110,
		},
		costTotal: 0.01,
	});
	const spawn = mock(async (agent: string) => ({
		text: `${agent}完成`,
		isError: false,
		usage: agent === "代码审查" ? usageOf(300) : undefined, // 一个采集失败降级
	}));
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-u3", {
		tasks: [
			{ agent: "代码审查", task: "a" },
			{ agent: "质量验收", task: "b" },
		],
	});
	// 只有一个子代理有用量：聚合结果就是它
	expect(res.usage?.input).toBe(300);
	expect(res.usage?.output).toBe(10);
	expect(res.usage?.cacheRead).toBe(100);
	expect(res.usage?.totalTokens).toBe(410);
	expect(res.usage?.cost.total).toBe(0.01);
});

test("makeSpawnFn: 派发登记 AbortController 到 abortRegistry，中止信号级联到 runSubagent", async () => {
	const resolveConfig = mock(async () => ({
		name: "test-agent",
		description: "test desc",
		systemPrompt: "you are a test agent",
		model: null,
		thinking: null,
		tools: [],
		skills: [],
	}));
	let capturedSignal: AbortSignal | undefined;
	// 模拟 runSubagent：挂起直到 signal 触发（对齐 subagent-runner 的中止语义）
	const fakeRunner = mock(
		async (_config: any, _task: string, _cwd: string, runOpts: any) => {
			capturedSignal = runOpts?.signal;
			await new Promise<void>((resolve) => {
				if (runOpts?.signal?.aborted) return resolve();
				runOpts?.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				});
			});
			return { text: "子智能体已被中止", isError: true, elapsedMs: 1 };
		},
	);
	const registry = new Set<AbortController>();
	const spawn = makeSpawnFn({
		resolveConfig,
		cwd: "/tmp",
		abortRegistry: registry,
		runSubagentAgent: fakeRunner as any,
	});

	const p = spawn("test-agent", "task", "tc-abort");
	// 等一拍让派发进入 runSubagent（controller 已登记）
	await new Promise((r) => setTimeout(r, 20));
	expect(registry.size).toBe(1);

	const [controller] = [...registry];
	controller.abort();
	const result = await p;

	expect(capturedSignal?.aborted).toBe(true);
	expect(result.isError).toBe(true);
	expect(result.text).toContain("已被中止");
	// 完成后从登记表移除（不泄漏）
	expect(registry.size).toBe(0);
});

// ---- 同名 agent 任务隔离（taskIndex）----
// 根因：fleet 同名 agent 的进度/统计按 agent 名做 key，互相覆盖，前端
// 显示「完成/进行中/失败一模一样」。修复：每个 fleet 任务分配 taskIndex
// （原始数组序号），从 spawn → onProgress → details 全链路携带。

// A1：fleet 同名 agent 多任务各自收到不同 taskIndex（原始数组序号）
test("fleet: 同名 agent 多任务各自收到不同 taskIndex（原始数组序号）", async () => {
	const taskIndexs: number[] = [];
	const spawn = mock(
		async (_agent: string, _task: string, _tcId: string, taskIndex?: number) => {
			taskIndexs.push(taskIndex!);
			return { text: "done", isError: false };
		},
	);
	const tool = makeFleetTool({ askTo, spawn });
	await tool.execute("tc-dup-idx", {
		tasks: [
			{ agent: "Explore", task: "A" },
			{ agent: "Explore", task: "B" },
			{ agent: "Explore", task: "C" },
		],
	});
	expect(taskIndexs).toEqual([0, 1, 2]);
});

// A2：同名 agent 的 details.fleet 按任务序号 key（不互相覆盖）
test("fleet: 同名 agent 的 details.fleet 按任务序号 key（不互相覆盖）", async () => {
	const spawn = mock(
		async (_agent: string, _task: string, _tcId: string, taskIndex?: number) => ({
			text: "done",
			isError: false,
			toolStats:
				taskIndex === 0
					? { total: 3, done: 2, error: 1, running: 0 }
					: { total: 5, done: 5, error: 0, running: 0 },
		}),
	);
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-dup-stats", {
		tasks: [
			{ agent: "Explore", task: "A" },
			{ agent: "Explore", task: "B" },
		],
	});
	expect(res.details).toEqual({
		fleet: {
			"0": { total: 3, done: 2, error: 1, running: 0 },
			"1": { total: 5, done: 5, error: 0, running: 0 },
		},
		interrupted: { "0": false, "1": false },
	});
});

// A3：越权项不打乱 taskIndex 编号（按原始数组序号）
test("fleet: 越权项不打乱 taskIndex 编号（按原始数组序号）", async () => {
	const spawn = mock(
		async (_agent: string, _task: string, _tcId: string, taskIndex?: number) => ({
			text: `idx-${taskIndex}`,
			isError: false,
		}),
	);
	const tool = makeFleetTool({ askTo: [], spawn });
	await tool.execute("tc-mix-idx", {
		tasks: [
			{ agent: "Explore", task: "A" }, // 0 → spawn
			{ agent: "陌生人", task: "X" }, // 1 → 越权跳过
			{ agent: "Explore", task: "B" }, // 2 → spawn
		],
	});
	// 第三个任务（原始序号 2）仍收到 taskIndex=2，未被越权项挤成 1
	expect(spawn.mock.calls.map((c) => c[3])).toEqual([0, 2]);
});

// A4：makeSpawnFn 把 taskIndex 注入 onProgress 事件（同名 agent 各帧带正确 index）
test("makeSpawnFn: fleet 调用时把 taskIndex 注入 onProgress 事件", async () => {
	const events: Array<{ agent: string; taskIndex?: number }> = [];
	const onProgress = mock((_tcId: string, event: any) =>
		events.push({ agent: event.agent, taskIndex: event.taskIndex }),
	);
	const spawnFn = makeSpawnFn({
		resolveConfig: async () => ({
			name: "Explore",
			description: "",
			systemPrompt: "",
			model: null,
			thinking: null,
			tools: [],
			skills: [],
		}),
		cwd: "/tmp",
		onProgress,
		runSubagentAgent: (async (
			_config: any,
			_task: string,
			_cwd: string,
			opts: any,
		) => {
			opts?.onProgress?.({
				agent: "Explore",
				status: "running",
				output: "",
				tools: [],
				elapsedMs: 1,
			});
			return { text: "done", isError: false, elapsedMs: 1 };
		}) as any,
	});
	// spawnFn 接受第 4 个参数 taskIndex（fleet 传入）
	await spawnFn("Explore", "task A", "tc-idx", 0);
	await spawnFn("Explore", "task B", "tc-idx", 1);
	expect(events.map((e) => e.taskIndex)).toEqual([0, 1]);
});

// A5：delegate 单任务路径不传 taskIndex（spawn 第 4 参为 undefined）
test("makeSpawnFn: 未传 taskIndex（delegate 单任务）时 onProgress 事件不带 taskIndex", async () => {
	const events: any[] = [];
	const onProgress = mock((_tcId: string, event: any) => events.push(event));
	const spawnFn = makeSpawnFn({
		resolveConfig: async () => ({
			name: "Explore",
			description: "",
			systemPrompt: "",
			model: null,
			thinking: null,
			tools: [],
			skills: [],
		}),
		cwd: "/tmp",
		onProgress,
		runSubagentAgent: (async (
			_config: any,
			_task: string,
			_cwd: string,
			opts: any,
		) => {
			opts?.onProgress?.({
				agent: "Explore",
				status: "running",
				output: "",
				tools: [],
				elapsedMs: 1,
			});
			return { text: "done", isError: false, elapsedMs: 1 };
		}) as any,
	});
	// delegate 路径只传 3 个参数，无 taskIndex
	await spawnFn("Explore", "task", "tc-single");
	expect(events[0].taskIndex).toBeUndefined();
});

test("makeSpawnFn getCallSignal：调用级信号 abort 时中止派发中的子代理", async () => {
	const callCtrl = new AbortController();
	let seenSignal: AbortSignal | undefined;
	const spawn = makeSpawnFn({
		resolveConfig: async () => ({
			name: "Explore",
			description: "探索",
			systemPrompt: "",
			model: null,
			thinking: null,
			tools: [],
			skills: [],
		}),
		cwd: "/tmp",
		getCallSignal: () => callCtrl.signal,
		// 注入桩实现绕过真实子进程：挂起直到信号中止（验证信号叠加传递）
		runSubagentAgent: async (_config, _task, _cwd, opts) => {
			seenSignal = opts?.signal;
			await new Promise<void>((r) =>
				opts?.signal?.addEventListener("abort", () => r(), { once: true }),
			);
			return { text: "子智能体已被中止", isError: true, elapsedMs: 1 };
		},
	});
	const p = spawn("Explore", "任务", "tc1");
	await new Promise((r) => setTimeout(r, 20));
	callCtrl.abort();
	const res = await p;
	expect(seenSignal?.aborted).toBe(true);
	expect(res.isError).toBe(true);
});

// A6：makeDelegateTool execute 调 spawn 只传 3 参（不传 taskIndex）
test("delegate: 单任务路径 execute 调 spawn 只传 3 参（不传 taskIndex）", async () => {
	const spawn = mock(async () => ({ text: "ok", isError: false }));
	const tool = makeDelegateTool({ askTo, spawn });
	await tool.execute("tc-single-del", { agent: "代码审查", task: "review" });
	expect(spawn.mock.calls[0]).toHaveLength(3);
});

// ---- fleet 失败/中断结果保留 ----
// 需求：任一子任务失败/中断时，所有子任务结果都必须保留在聚合 text 里且中断者有明确标记；
// 整体中止（外部 signal）要等各子任务收尾完成再聚合；单任务失败/异常不连坐其他任务。

// B1：fleet 3 任务（1 成功 / 1 失败 / 1 中断）→ 三者结果都进聚合 text，标记各自准确
test("fleet: 成功/失败/中断混合——三者结果都保留，中断标「中断」失败标「失败」成功无标记", async () => {
	const spawn = mock(
		async (agent: string): Promise<any> => {
			if (agent === "代码审查")
				return { text: "评审通过，无问题", isError: false };
			if (agent === "质量验收")
				return { text: "断言失败：预期 3 实际 2", isError: true };
			// 中断：text 已含 subagent-runner 中止路径生成的部分进度段
			return {
				text: "子智能体已被中止\n\n部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）",
				isError: true,
				interrupted: true,
			};
		},
	);
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-fleet-keep", {
		tasks: [
			{ agent: "代码审查", task: "review" },
			{ agent: "质量验收", task: "test" },
			{ agent: "Explore", task: "explore" },
		],
	});
	expect(res.isError).toBe(true);
	const text = res.content[0].text;
	// 三者内容都在（含中断者的部分进度段）
	expect(text).toContain("评审通过，无问题");
	expect(text).toContain("断言失败：预期 3 实际 2");
	expect(text).toContain("子智能体已被中止");
	expect(text).toContain("部分进度：工具调用 3 个（成功 1 / 失败 1 / 中断 1）");
	// 标题标记：成功者无标记、失败者「（失败）」、中断者「（失败·中断）」（真实中止路径
	// isError 恒为 true，故标后者；纯 interrupted 字段由映射独立渲染为「（中断）」）
	expect(text).toContain("【代码审查】\n评审通过，无问题");
	expect(text).toContain("【质量验收】（失败）");
	expect(text).toContain("【Explore】（失败·中断）");
	expect(text).not.toContain("【代码审查】（");
	// details.interrupted 只标中断者
	expect(res.details?.interrupted).toEqual({
		"0": false,
		"1": false,
		"2": true,
	});
});

// B2：fleet 整体中止（外部 signal 级联）——等所有子任务收尾完成再聚合，结果一个不丢。
// 桩 runner 对齐 subagent-runner 真实中止路径的返回形状（中止文案 + 部分进度段 + interrupted）；
// signal 级联走 makeSpawnFn 的真实 AbortController 逻辑（getCallSignal 注入）。
test("fleet: 整体中止——已完成子任务结果完整保留，被中止子任务带部分进度段", async () => {
	const ctrl = new AbortController();
	const fakeRunner = async (
		_config: any,
		task: string,
		_cwd: string,
		opts: any,
	) => {
		if (task === "快任务") {
			return { text: "快任务完成", isError: false, elapsedMs: 1 };
		}
		// 卡任务：挂起直到 signal 中止（模拟卡死子代理），随后走中止收尾路径
		await new Promise<void>((resolve) => {
			if (opts?.signal?.aborted) return resolve();
			opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return {
			text: "子智能体已被中止\n\n部分进度：工具调用 1 个（成功 1 / 失败 0 / 中断 0）",
			isError: true,
			interrupted: true,
			elapsedMs: 1,
		};
	};
	const spawn = makeSpawnFn({
		resolveConfig: async () => ({
			name: "test-agent",
			description: "test desc",
			systemPrompt: "you are a test agent",
			model: null,
			thinking: null,
			tools: [],
			skills: [],
		}),
		cwd: "/tmp",
		getCallSignal: () => ctrl.signal,
		runSubagentAgent: fakeRunner as any,
	});
	const tool = makeFleetTool({ askTo, spawn });
	const resultP = tool.execute("tc-fleet-abort", {
		tasks: [
			{ agent: "代码审查", task: "快任务" },
			{ agent: "质量验收", task: "卡任务" },
		],
	});
	// 等快任务完成、卡任务挂起，再模拟外部中止（bridge 断连/用户停止）
	await new Promise((r) => setTimeout(r, 50));
	ctrl.abort();
	const res = await resultP; // 不得 reject：必须等收尾完成后正常聚合返回
	const text = res.content[0].text;
	expect(text).toContain("快任务完成"); // 已完成子任务完整保留
	expect(text).toContain("子智能体已被中止"); // 被中止子任务收尾结果进聚合
	expect(text).toContain("部分进度：工具调用 1 个（成功 1 / 失败 0 / 中断 0）");
	expect(res.details?.interrupted).toEqual({ "0": false, "1": true });
}, 10_000);

// B3：先头任务失败不影响排队任务——8 任务超并发上限（6），末尾 2 个排队仍执行
test("fleet: 先头任务失败不影响排队任务——超出并发上限的任务照常执行且结果全保留", async () => {
	const executed: string[] = [];
	const spawn = mock(
		async (_agent: string, task: string): Promise<any> => {
			executed.push(task);
			if (task === "任务0") return { text: "任务0失败", isError: true };
			return { text: `${task}完成`, isError: false };
		},
	);
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-fleet-queue", {
		tasks: Array.from({ length: 8 }, (_, i) => ({
			agent: i === 0 ? "代码审查" : "质量验收",
			task: `任务${i}`,
		})),
	});
	// 全部 8 个任务都被执行（含排队中尚未启动的 6、7）
	expect(executed).toHaveLength(8);
	const text = res.content[0].text;
	// 失败者与其余 7 个成功者的结果全部保留
	expect(text).toContain("任务0失败");
	for (let i = 1; i < 8; i++) expect(text).toContain(`任务${i}完成`);
	expect(text).toContain("【代码审查】（失败）");
});

// B4：spawn 意外异常（reject）不连坐——异常转结构化失败，其余任务结果保留
test("fleet: 单任务 spawn 抛异常不连坐——其余任务结果保留，异常任务标「失败·中断」", async () => {
	const spawn = mock(
		async (_agent: string, task: string): Promise<any> => {
			if (task === "任务0") throw new Error("配置读取崩溃");
			return { text: `${task}完成`, isError: false };
		},
	);
	const tool = makeFleetTool({ askTo, spawn });
	const res = await tool.execute("tc-fleet-throw", {
		tasks: [
			{ agent: "代码审查", task: "任务0" },
			{ agent: "质量验收", task: "任务1" },
		],
	});
	const text = res.content[0].text;
	expect(text).toContain("任务1完成"); // 其余任务不受影响
	expect(text).toContain("配置读取崩溃"); // 异常信息对主代理可见
	expect(text).toContain("【代码审查】（失败·中断）"); // 异常属非正常终态
	expect(res.details?.interrupted?.["0"]).toBe(true);
	expect(res.isError).toBe(true);
});
