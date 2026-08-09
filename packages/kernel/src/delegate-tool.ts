// delegate 关系网调起工具。
//
// LLM 经 delegate(agent, task) 调起 askTo 内的智能体：
// - allowlist 在宿主侧强制（扩展原生 subagent 工具不进 allowlist，见 constants.resolveAgentTools）。
// - 越权调起返回错误文本，不触碰 service。
// - 合法调起经 spawn 闭包执行：wa-pi 自实现的 subagent-runner
//   （kernel 直接 spawn 一次性 pi RPC 子进程，见 subagent-runner.ts）。
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
import type {
	DelegationHints,
	SubagentProgressEvent,
	ToolStats,
} from "@wa-pi/shared";
import type { WaPiSpawnConfig, SubagentUsage } from "./subagent-runner";
import { runSubagentAgent as defaultRunSubagentAgent } from "./subagent-runner";
import type { SpawnTelemetryInput } from "./subagent-telemetry";

/** fleet 工具并行派发子任务的最大并发上限，超出部分排队等待。也作为内部 runWithConcurrency 的默认限流值。
 * 控制为 5：每个子代理 pi 进程约占 300MB，5 个 ≈ 1.5GB，避免累积超 macOS 内存限制被 SIGKILL。 */
export const MAX_SUBAGENT_CONCURRENCY = 5;

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
	/** 子代理工具调用统计（与实时 progress 同源；异常路径为 undefined） */
	toolStats?: ToolStats;
	elapsedMs?: number;
}

// 第三个参数 toolCallId 用于把子代理执行进度帧关联到前端对应的 DelegateCard
// （前端按 toolCallId 定位卡片）。fleet 下所有子任务共享同一个 fleet 工具调用的 toolCallId。
export type DelegateSpawnFn = (
	agent: string,
	task: string,
	toolCallId: string,
	/** fleet 任务序号（0-based）；fleet execute 传入，spawn 闭包据此注入 onProgress 事件 */
	taskIndex?: number,
) => Promise<DelegateSpawnResult>;

/**
 * 判断 agent 名是否允许调起：在 askTo 名单内，或者是内置 subagent 类型名。
 * 内置类型（general-purpose / Explore / Plan）走本地 .md 定义（pi-open-agents
 * frontmatter 格式，见 builtin-agents.ts），不在 WaPi 的 askTo 关系网里——
 * 任何主智能体都可调起。
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

/**
 * 子代理用量转 pi ToolResultMessage.usage 形状（pi getSessionStats 的
 * addUsageToTotals 直接读取 input/output/cacheRead/cacheWrite/cost.total，
 * 全部必须为数，否则 NaN）。携带后 pi 官方 stats 会原生把子代理计入累计。
 */
function toPiToolUsage(u?: SubagentUsage) {
	if (!u) return undefined;
	const t = u.tokens;
	return {
		input: t.input ?? 0,
		output: t.output ?? 0,
		cacheRead: t.cacheRead ?? 0,
		cacheWrite: t.cacheWrite ?? 0,
		totalTokens:
			t.total ??
			(t.input ?? 0) +
				(t.output ?? 0) +
				(t.cacheRead ?? 0) +
				(t.cacheWrite ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: u.costTotal ?? 0,
		},
	};
}

/** 多子代理用量聚合（fleet）：tokens 逐项相加，cost.total 相加；无任何用量返回 undefined */
function sumPiToolUsage(usages: Array<SubagentUsage | undefined>) {
	const shaped = usages.map(toPiToolUsage).filter((x) => x != null);
	if (shaped.length === 0) return undefined;
	const acc = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const u of shaped) {
		acc.input += u.input;
		acc.output += u.output;
		acc.cacheRead += u.cacheRead;
		acc.cacheWrite += u.cacheWrite;
		acc.totalTokens += u.totalTokens;
		acc.cost.total += u.cost.total;
	}
	return acc;
}

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
			toolCallId: string,
			args: { agent: string; task: string },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: undefined;
			isError: boolean;
			usage?: ReturnType<typeof toPiToolUsage>;
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
			// 透传 toolCallId：前端 DelegateCard 靠它定位卡片，进度帧需关联到正确卡片
			const { text, isError, usage } = await opts.spawn(
				spawnAgent,
				args.task,
				toolCallId,
			);
			return {
				content: [{ type: "text" as const, text }],
				details: undefined,
				isError,
				// 子代理用量随 toolResult 上报：pi 官方 stats 原生计入累计（usage reported by tools）
				usage: toPiToolUsage(usage),
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
	/** 子代理中止登记表：每次派发创建一个 AbortController 加入本表（完成时移除），
	 *  主会话 abort / 会话拆除时由 agent-manager 级联触发表内全部 controller，
	 *  runSubagent 收到 signal 后优雅中止子代理进程（否则成孤儿跑到完成、结果无人消费）。 */
	abortRegistry?: Set<AbortController>;
	// onProgress 改为 (toolCallId, event)：spawn 闭包拿到 toolCallId 后注入到回调，
	// 让前端能按 toolCallId 把进度帧路由到对应卡片
	onProgress?: (toolCallId: string, event: SubagentProgressEvent) => void;
	/** 每次派发（含失败）结束后回调，用于会话级遥测收集（agent-manager 注入） */
	onSpawnComplete?: (input: SpawnTelemetryInput) => void;
	/** 测试覆盖：pi CLI 入口 / 运行时 / 超时（透传给 runSubagentAgent） */
	runnerOpts?: {
		cliPath?: string;
		runtime?: string;
		commandTimeoutMs?: number;
	};
	/** 随子进程加载的扩展文件（-e）：provider-extension 必须传入，
	 *  否则子进程的 pi 不认识主会话的自定义 provider，--model 会因 No API key 失败 */
	extensionPaths?: string[];
	/**
	 * 派发前确保 provider-extension 覆盖子智能体所需的 provider slug。
	 * 传入从 config.model 解析出的 provider slug（形如 "deepseek"）；
	 * model 为 null（跟随主模型）时传 undefined，由实现决定是否无条件重生。
	 * 实现负责按需调用 ensureProviderExtensionRegistered 重新生成 extension 文件，
	 * 防止 extension 与 providers.json 不同步导致子进程报 "No API key found"。
	 */
	ensureExtension?: (requiredSlug?: string) => Promise<void>;
	/**
	 * 测试覆盖：注入 runSubagentAgent 实现。
	 * 仅用于绕过测试进程内 mock.module 对 "./subagent-runner" 的进程级污染
	 * （见 agent-manager-subagent-overrides.test.ts）；生产调用不传，默认用顶部 import 的实现。
	 */
	runSubagentAgent?: typeof defaultRunSubagentAgent;
}): DelegateSpawnFn {
	const runSubagent = opts.runSubagentAgent ?? defaultRunSubagentAgent;
	// 闭包接受 toolCallId（来自 delegate/fleet execute 透传），用于把 onProgress 关联到正确卡片
	return async (
		agent: string,
		task: string,
		toolCallId: string,
		taskIndex?: number,
	) => {
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
		// skillsAllOff=true 表示显式全不选：子代理也不加载任何技能（传空数组）
		// 否则 skills 非空按白名单解析，空数组则 undefined（保持原语义）
		const skillPaths = config.skillsAllOff
			? []
			: opts.resolveSkillPaths && config.skills.length
				? await opts.resolveSkillPaths(config.skills)
				: undefined;
		// 派发前自愈 provider-extension：从 config.model（形如 "provider/model"）解析出所需 provider slug，
		// 交由 ensureExtension 校验/重生 extension 文件，避免子进程加载过时空壳报 "No API key found"。
		if (opts.ensureExtension) {
			const modelSlug =
				config.model && config.model.includes("/")
					? config.model.slice(0, config.model.indexOf("/"))
					: undefined;
			await opts.ensureExtension(modelSlug);
		}
		// 每次派发一个 AbortController 并登记：主会话 abort / 会话拆除时级联触发；
		// 叠加外层 signal（若有），任一触发都中止本次子代理。
		const controller = new AbortController();
		opts.abortRegistry?.add(controller);
		if (opts.signal?.aborted) controller.abort();
		else
			opts.signal?.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		try {
			const result = await runSubagent(config, task, opts.cwd, {
				signal: controller.signal,
				// 把外层 onProgress(toolCallId, event) 包一层：runSubagentAgent 内部仍以
				// (event) => void 调用，这里注入闭包捕获的 toolCallId，实现进度帧关联卡片
				onProgress: opts.onProgress
					? (event) => opts.onProgress!(toolCallId, { ...event, taskIndex })
					: undefined,
				skillPaths,
				extensionPaths: opts.extensionPaths,
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
		} finally {
			opts.abortRegistry?.delete(controller);
		}
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
			return undefined;
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
			toolCallId: string,
			args: { tasks: Array<{ agent: string; task: string }> },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { fleet: Record<string, ToolStats> } | undefined;
			isError: boolean;
			usage?: ReturnType<typeof sumPiToolUsage>;
		}> {
			if (args.tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: "无任务" }],
					details: undefined,
					isError: false,
				};
			}
			const results = await runWithConcurrency(
				args.tasks.map((t, index) => async () => {
					if (!canInvoke(t.agent, opts.askTo)) {
						return {
							index,
							agent: t.agent,
							text: buildNotAllowedMessage(t.agent, opts.askTo),
							isError: true,
						};
					}
					// 内置 subagent 中文别名归一化（同 delegate 单任务路径）
					const spawnAgent = normalizeSubagentType(t.agent);
					// fleet 所有子任务共享同一个 fleet 工具调用的 toolCallId：
					// 前端 FleetCard 靠它定位卡片，内部按 progress.taskIndex 区分各子任务
					const { text, isError, toolStats, usage } = await opts.spawn(
						spawnAgent,
						t.task,
						toolCallId,
						index,
					);
					return { index, agent: t.agent, text, isError, toolStats, usage };
				}),
				MAX_SUBAGENT_CONCURRENCY,
			);
			// 按输入顺序聚合为单段文本；details 携带各子代理工具调用统计（刷新后仍可显示）
			const lines = results.map(
				(r) => `【${r.agent}】${r.isError ? "（失败）" : ""}\n${r.text}`,
			);
			const anyError = results.some((r) => r.isError);
			const fleetStats: Record<string, ToolStats> = {};
			for (const r of results)
				if (r.toolStats) fleetStats[String(r.index)] = r.toolStats;
			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: { fleet: fleetStats },
				isError: anyError,
				// 各子代理用量聚合上报：pi 官方 stats 原生计入累计（usage reported by tools）
				usage: sumPiToolUsage(results.map((r) => r.usage)),
			};
		},
	};
}
