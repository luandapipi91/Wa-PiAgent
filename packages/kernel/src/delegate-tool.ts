// delegate 关系网调起工具 + pi-open-agents runSubagent 适配。
//
// LLM 经 delegate(agent, task) 调起 askTo 内的智能体：
// - allowlist 在宿主侧强制（扩展原生 subagent 工具不进 allowlist，见 constants.resolveAgentTools）。
// - 越权调起返回错误文本，不触碰 service。
// - 合法调起经 spawn 闭包执行：pi-open-agents 的 runSubagent（子进程 async），
//   由 subagent-runner 适配层封装。
//
// 错误语义：execute 返回值带 isError 标记。SDK 层（pi-agent-core）目前不把
// result.isError 透传到 ToolResultMessage（仅 execute 抛异常才标 isError），
// 错误信息经文本传达给 LLM——与原生 subagent 工具先例一致
//（其所有错误路径均返回普通文本）。
import {
	DELEGATE_DESCRIPTION,
	FLEET_DESCRIPTION,
	DelegateParamsSchema,
	FleetParamsSchema,
} from "@wa-pi/shared";
import {
	isSubagentType,
	SUBAGENT_TYPES,
	normalizeSubagentType,
} from "@wa-pi/shared";
import type { DelegationHints } from "@wa-pi/shared";
import type {
	WaPiSpawnConfig,
	SubagentProgressEvent,
	SubagentUsage,
} from "./subagent-runner";
import { runSubagentAgent } from "./subagent-runner";
import type { SpawnTelemetryInput } from "./subagent-telemetry";

/** fleet 工具并行派发子任务的最大并发上限，超出部分排队等待。也作为内部 runWithConcurrency 的默认限流值 */
export const MAX_SUBAGENT_CONCURRENCY = 6;

export interface DelegateTarget {
	name: string;
	description: string;
	delegationHints?: DelegationHints;
}

/** spawn 闭包返回值：text 给 LLM，isError 标记失败（服务未就绪/调起异常/子智能体失败/超时/中止） */
export interface DelegateSpawnResult {
	text: string;
	isError: boolean;
	/** 子代理 token 用量（pi get_session_stats 采集失败时为 undefined） */
	usage?: SubagentUsage;
	elapsedMs?: number;
}

export type DelegateSpawnFn = (
	agent: string,
	task: string,
) => Promise<DelegateSpawnResult>;

/**
 * 判断 agent 名是否允许调起：在 askTo 名单内，或者是内置 subagent 类型名。
 * 内置类型（general-purpose / Explore / Plan）走 pi-open-agents 的 AgentDefinition，
 * 不在 WaPi 的 askTo 关系网里——任何主智能体都可调起。
 */
function canInvoke(agent: string, askTo: DelegateTarget[]): boolean {
	return askTo.some((t) => t.name === agent) || isSubagentType(agent);
}

/** 构造"可调起名单"错误文案：实名列表 + 内置类型提示 */
function buildNotAllowedMessage(
	agent: string,
	askTo: DelegateTarget[],
): string {
	const names = askTo.map((t) => t.name).join("、") || "（空）";
	const builtin = SUBAGENT_TYPES.map((t) => t.name).join("、");
	return `错误：智能体「${agent}」不在可调起列表中。可调起：${names}；内置 subagent 类型：${builtin}`;
}

/** 单个智能体在总览中的展示信息（内置与命名统一结构） */
export interface RosterEntry {
	name: string;
	description: string;
	delegationHints?: DelegationHints;
}

/**
 * 拼装可用子智能体总览段（注入系统提示词），XML 结构化标签格式。
 * 内置类型与命名智能体统一为一个列表，结构一致：名称+简介+hints+定义文件路径。
 */
export function buildDelegateRoster(
	askTo: DelegateTarget[],
	builtinHints: Record<string, DelegationHints | undefined> = {},
	agentsDir = "",
): string {
	const entries: RosterEntry[] = [];
	// 内置类型（始终列出）
	for (const t of SUBAGENT_TYPES) {
		entries.push({
			name: t.name,
			description: t.description,
			delegationHints: builtinHints[t.name],
		});
	}
	// 命名智能体
	for (const t of askTo) {
		entries.push({
			name: t.name,
			description: t.description,
			delegationHints: t.delegationHints,
		});
	}
	if (entries.length === 0) return "";
	const blocks = entries.map((e) => {
		const lines = ["<agent>"];
		lines.push(`  <name>${e.name}</name>`);
		lines.push(`  <description>${e.description || "（无简介）"}</description>`);
		if (agentsDir)
			lines.push(`  <location>${agentsDir}/${e.name}.md</location>`);
		const h = e.delegationHints;
		if (h?.whenToDelegate)
			lines.push(`  <whenToDelegate>${h.whenToDelegate}</whenToDelegate>`);
		if (h?.whenNotTo) lines.push(`  <whenNotTo>${h.whenNotTo}</whenNotTo>`);
		if (h?.benefit) lines.push(`  <benefit>${h.benefit}</benefit>`);
		lines.push("</agent>");
		return lines.join("\n");
	});
	return (
		"## Available Subagents\n\nInvoke via the delegate tool:\n<subagents>\n" +
		blocks.join("\n") +
		"\n</subagents>"
	);
}

/** 构造 delegate 工具（闭包绑 askTo + spawn）。每个 session 一份实例，始终注册（内置类型不依赖 askTo）。 */
export function makeDelegateTool(opts: {
	askTo: DelegateTarget[];
	spawn: DelegateSpawnFn;
}) {
	return {
		name: "delegate",
		label: "Delegate",
		description: DELEGATE_DESCRIPTION,
		parameters: DelegateParamsSchema,
		async execute(
			_toolCallId: string,
			args: { agent: string; task: string },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
			isError: boolean;
		}> {
			if (!canInvoke(args.agent, opts.askTo)) {
				return {
					content: [
						{
							type: "text" as const,
							text: buildNotAllowedMessage(args.agent, opts.askTo),
						},
					],
					details: undefined,
					isError: true,
				};
			}
			// 内置 subagent 中文别名（如"通用子智能体"）归一化为英文 name（"general-purpose"），
			// 让 spawn 闭包传给 subagent-runner 时能正确匹配 AgentDefinition
			const spawnAgent = normalizeSubagentType(args.agent);
			const { text, isError } = await opts.spawn(spawnAgent, args.task);
			return {
				content: [{ type: "text" as const, text }],
				details: undefined,
				isError,
			};
		},
	};
}

/**
 * spawn 闭包工厂：绑定 WaPi config + cwd + 过程回调，
 * 调用 subagent-runner 的 runSubagentAgent 执行子智能体。
 *
 * resolveConfig 由 agent-manager 从 AgentConfig 提取（name/description/systemPrompt/model/thinking/tools/skills）。
 * onProgress 回调实时转发子智能体执行过程（工具调用/文本输出），用于前端过程展示。
 */
export function makeSpawnFn(opts: {
	resolveConfig: (agentName: string) => Promise<WaPiSpawnConfig | null>;
	/** 将 skills 白名单（name[]）解析为文件路径；未提供则子代理不加载技能 */
	resolveSkillPaths?: (skillNames: string[]) => Promise<string[]>;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (event: SubagentProgressEvent) => void;
	/** 每次派发（含失败）结束后回调，用于会话级遥测收集（agent-manager 注入） */
	onSpawnComplete?: (input: SpawnTelemetryInput) => void;
	/** 测试覆盖：pi CLI 入口 / 运行时 / 超时（透传给 runSubagentAgent） */
	runnerOpts?: {
		cliPath?: string;
		runtime?: string;
		commandTimeoutMs?: number;
	};
}): DelegateSpawnFn {
	return async (agent: string, task: string) => {
		const config = await opts.resolveConfig(agent);
		if (!config) {
			const result = { text: `智能体「${agent}」配置未找到`, isError: true };
			opts.onSpawnComplete?.({
				agent,
				task,
				isError: true,
				returnText: result.text,
			});
			return result;
		}
		const skillPaths = opts.resolveSkillPaths && config.skills.length
			? await opts.resolveSkillPaths(config.skills)
			: undefined;
		const result = await runSubagentAgent(config, task, opts.cwd, {
			signal: opts.signal,
			onProgress: opts.onProgress,
			skillPaths,
			cliPath: opts.runnerOpts?.cliPath,
			runtime: opts.runnerOpts?.runtime,
			commandTimeoutMs: opts.runnerOpts?.commandTimeoutMs,
		});
		opts.onSpawnComplete?.({
			agent,
			task,
			isError: result.isError,
			returnText: result.text,
			elapsedMs: result.elapsedMs,
			childUsage: result.usage,
		});
		return result;
	};
}

/** 简易并发限制器：按 limit 并发执行 thunks，结果按输入顺序返回 */
async function runWithConcurrency<T>(
	thunks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	const results: T[] = new Array(thunks.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(limit, thunks.length) },
		async () => {
			while (cursor < thunks.length) {
				const i = cursor++;
				results[i] = await thunks[i]();
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/** 构造 fleet 工具：并行派发多个 delegate 任务，按输入顺序聚合结果 */
export function makeFleetTool(opts: {
	askTo: DelegateTarget[];
	spawn: DelegateSpawnFn;
}) {
	const fleetDesc = FLEET_DESCRIPTION.replace(
		"Concurrency limit is 6",
		`Concurrency limit is ${MAX_SUBAGENT_CONCURRENCY}`,
	);
	return {
		name: "fleet",
		label: "Fleet",
		description: fleetDesc,
		parameters: FleetParamsSchema,
		async execute(
			_toolCallId: string,
			args: { tasks: Array<{ agent: string; task: string }> },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
			isError: boolean;
		}> {
			if (args.tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: "无任务" }],
					details: undefined,
					isError: false,
				};
			}
			const results = await runWithConcurrency(
				args.tasks.map((t) => async () => {
					if (!canInvoke(t.agent, opts.askTo)) {
						return {
							agent: t.agent,
							text: buildNotAllowedMessage(t.agent, opts.askTo),
							isError: true,
						};
					}
					// 内置 subagent 中文别名归一化（同 delegate 单任务路径）
					const spawnAgent = normalizeSubagentType(t.agent);
					const { text, isError } = await opts.spawn(spawnAgent, t.task);
					return { agent: t.agent, text, isError };
				}),
				MAX_SUBAGENT_CONCURRENCY,
			);
			// 按输入顺序聚合为单段文本
			const lines = results.map(
				(r) => `【${r.agent}】${r.isError ? "（失败）" : ""}\n${r.text}`,
			);
			const anyError = results.some((r) => r.isError);
			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: undefined,
				isError: anyError,
			};
		},
	};
}
