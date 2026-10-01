// delegate 关系网调起工具。
//
// LLM 经 delegate(tasks:[{agent, task}]) 调起 askTo 内的智能体：
// - allowlist 在宿主侧强制（扩展原生 subagent 工具不进 allowlist，见 constants.resolveAgentTools）。
// - 越权调起返回错误文本，不触碰 service。
// - 合法调起经 spawn 闭包执行：wa-pi 自实现的 subagent-runner
//   （kernel 直接 spawn 一次性 pi RPC 子进程，见 subagent-runner.ts）。
// - 每个子任务派发前生成 agentId，并把 pi 的 --session 指向
//   <WA_PI_DIR>/subagents/<父会话 id>/<agentId>.jsonl（完整转录落盘，见 subagent-instance-store.ts）；
//   派发前/后各写一次 meta（running → 终态）。返回 XML 块（规格 §7）带 agentId 与转录路径。
// - resume 分支（规格 §6）：tasks[].resume 填上次返回的 <agent_id> 时续聊同一实例——
//   类型以 meta.subagentType 为准、复用同一份 jsonl（不新建）、resumeCount 递增；
//   权限在首次派发时已校验，故续聊不再过 askTo。
//
// 错误语义：execute 返回值带 isError 标记。SDK 层（pi-agent-core）目前不把
// result.isError 透传到 ToolResultMessage（仅 execute 抛异常才标 isError），
// 错误信息经文本传达给 LLM——与原生 subagent 工具先例一致
//（其所有错误路径均返回普通文本）。
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
	DELEGATE_DESCRIPTION,
	DELEGATE_MAX_TASKS as MAX_SUBAGENT_CONCURRENCY,
	DelegateParamsSchema,
	WA_PI_DIR,
} from "@wa-pi/shared";
import {
	isSubagentType,
	SUBAGENT_TYPES,
	normalizeSubagentType,
} from "@wa-pi/shared";
import type {
	DelegationHints,
	SubagentDetails,
	SubagentProgressEvent,
	ToolStats,
} from "@wa-pi/shared";
import type { SubagentMeta } from "./subagent-instance-store";
import {
	assertAgentId,
	jsonlPath,
	newAgentId,
	readMeta,
	writeMeta,
} from "./subagent-instance-store";
import type { WaPiSpawnConfig, SubagentUsage } from "./subagent-runner";
import {
	buildPartialProgressNote,
	runSubagentAgent as defaultRunSubagentAgent,
} from "./subagent-runner";
import type { SpawnTelemetryInput } from "./subagent-telemetry";

/** 单次委托的并发/任务数上限——定义唯一来源在 @wa-pi/shared 的 tool-schemas.ts（DELEGATE_MAX_TASKS），
 * 此处按旧名重导出兼容既有引用。 */
export { MAX_SUBAGENT_CONCURRENCY };

export interface DelegateTarget {
	name: string;
	description: string;
	delegationHints?: DelegationHints;
}

/** spawn 闭包返回值：text 给 LLM，isError 标记失败（服务未就绪/调起异常/子智能体失败/超时/中止） */
export interface DelegateSpawnResult {
	text: string;
	isError: boolean;
	/** 结构化中断标记：子代理被中止/超时/异常提前终止（未正常跑完）时为 true；
	 *  正常完成与模型终态失败不标记。isError 语义不变，前端据此区分「中断」与普通失败 */
	interrupted?: boolean;
	/** 子代理 token 用量（pi get_session_stats 采集失败时为 undefined） */
	usage?: SubagentUsage;
	/** 子代理工具调用统计（与实时 progress 同源；异常路径为 undefined） */
	toolStats?: ToolStats;
	elapsedMs?: number;
}

// 第三个参数 toolCallId 用于把子代理执行进度帧关联到前端对应的 DelegateCard
// （前端按 toolCallId 定位卡片）。多任务时所有子任务共享同一次工具调用的 toolCallId。
// 第五个参数 sessionFile：子代理转录落盘路径（pi --session），由 execute 按 agentId 算出后透传；
// 不传则回退 --no-session（不落盘），故为可选（紧跟同样可选的 taskIndex 之后）。
export type DelegateSpawnFn = (
	agent: string,
	task: string,
	toolCallId: string,
	/** 任务序号（0-based）；execute 传入，spawn 闭包据此注入 onProgress 事件 */
	taskIndex?: number,
	/** 子代理转录落盘路径（pi --session <path>）；空/缺省时不落盘 */
	sessionFile?: string,
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
 * 拼装可用子智能体总览段（注入系统提示词），紧凑列表格式（一行一智能体）。
 * 内置类型与命名智能体统一为一个列表：名称 + 简介 + 可选 hints（何时派/不派/收益）。
 * 2026-09-18 委派提示词 ≤600 tok 优化：舍弃 XML 标签与定义文件路径等元数据（占位大且不参与派发判定）。
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
	void agentsDir; // 紧凑格式不再输出定义文件路径（纯元数据）；参数保留以兼容调用方
	const lines = entries.map((e) => {
		let line = `- ${e.name}：${e.description || "（无简介）"}`;
		const h = e.delegationHints;
		if (h?.whenToDelegate) line += `；何时派：${h.whenToDelegate}`;
		if (h?.whenNotTo) line += `；不派：${h.whenNotTo}`;
		if (h?.benefit) line += `；收益：${h.benefit}`;
		return line;
	});
	return (
		"## Available Subagents（agent 参数填下列名称）\n" +
		lines.join("\n")
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
			(t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: u.costTotal ?? 0,
		},
	};
}

// ===== 返回块渲染（规格 §7 定稿）=====

/** 3_600_000 → "60m0s"；95_000 → "1m35s"；32_000 → "32s" */
export function formatElapsedShort(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}m${s}s`;
}

/** 8_100 → "8.1k"；950 → "950"；undefined → "?" */
export function formatTokensShort(n?: number): string {
	if (n == null) return "?";
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

/**
 * XML 转义动态内容：`&` 必须**最先**处理（否则 `<` 先变 `&lt;` 再被 `&`→`&amp;`
 * 二次转义成 `&amp;lt;`）。`>` 不转义（XML 中裸 `>` 合法，最小干预）。
 * 只用于子代理正文与 `<type>`/`<status>` 等取值，绝不动渲染模板本身的结构字符。
 */
function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * 渲染单个子代理结果块（规格 §7 定稿：XML、标签同行紧凑排版、全字段保留）。
 * `<agent_id>` 与 `<transcript>` 都是独立子元素（后者为绝对路径，主 agent 自行 read/grep）；
 * `<result>` 包裹正文并以换行分隔——正文是任意文本（报告常含代码与标签字面串），
 * 必须做 XML 转义，否则正文里的 `</result>`/`</subagent>` 会提前闭合结构、破坏多块拼接。
 * 未建实例的任务（如越权项）agentId / jsonlPath 为空串，模型据此知道没转录可查。
 */
export function renderSubagentBlock(r: {
	taskIndex: number;
	agentId: string;
	subagentType: string;
	status: "completed" | "failed" | "interrupted";
	elapsedMs?: number;
	totalTokens?: number;
	resumed: boolean;
	jsonlPath: string;
	text: string;
}): string {
	return (
		`<subagent><index>${r.taskIndex}</index><agent_id>${r.agentId}</agent_id>` +
		`<type>${escapeXml(r.subagentType)}</type><status>${escapeXml(r.status)}</status>` +
		`<elapsed>${formatElapsedShort(r.elapsedMs ?? 0)}</elapsed>` +
		`<tokens>${formatTokensShort(r.totalTokens)}</tokens>` +
		`<resumed>${r.resumed}</resumed>` +
		`<transcript>${r.jsonlPath}</transcript><result>\n${escapeXml(r.text)}\n</result></subagent>`
	);
}

/** 错误对象转可读文本（console.warn 用）；非 Error 一律 String() */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * pi 用已有 jsonl resume 时要求首行记录的 cwd 目录存在，否则非交互模式 exit(1)
 *（"Stored session working directory does not exist"）。这里复用主会话同款自愈思路
 *（agent-manager.readStoredSessionCwd）：读回首行 cwd 并补建目录。
 */
async function selfHealStoredCwd(jsonlFile: string): Promise<void> {
	try {
		const rl = createInterface({
			input: createReadStream(jsonlFile, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			rl.close();
			const cwd = (JSON.parse(line) as { cwd?: string }).cwd;
			if (typeof cwd === "string" && cwd) {
				await mkdir(cwd, { recursive: true }).catch(() => {});
			}
			return;
		}
	} catch {
		/* 文件不存在或坏行：交给 pi 按新会话处理 */
	}
}

/**
 * 写实例 meta：写盘失败不阻断派发主流程（meta 只是审计与 resume 的辅助通道，
 * 与中止快照 writeAbortSnapshot 同约定），但**留一次 console.warn**——「错误经文本
 * 传达」不等于连日志都不该有，静默失败会让「pi 拿到指向不存在文件的 --session」
 * 「resume 误拒」等故障无从排查。
 * 返回是否落盘成功：调用方据此决定是否仍宣告 <transcript>（写不进同一目录 =
 * 转录文件大概率也不存在，宣告它会骗模型去 read 一个 404）。
 */
async function safeWriteMeta(meta: SubagentMeta): Promise<boolean> {
	try {
		await writeMeta(meta);
		return true;
	} catch (err) {
		console.warn(
			`[delegate] 子代理 meta 写入失败（agentId=${meta.agentId}，status=${meta.status}）：${errorMessage(err)}`,
		);
		return false;
	}
}

/** 多子代理用量聚合：tokens 逐项相加，cost.total 相加；无任何用量返回 undefined */
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

// ===== 中止快照（subagent-results 文件中转）=====
//
// 用户在父会话点停止 → pi 侧 bridge 流被 cancel，delegate 的 final 帧无人
// 消费（流已死）。execute 在 abort 瞬间用内存进度组装 final 快照立即落盘（pi 侧
// 轮询窗口仅 abort 后 5 秒，settle 收尾最长 ABORT_GRACE_MS=10s 必然错过窗口），
// 全部子任务 settle 后再用最终状态覆盖写一次（信息更全，pi 已读过也不影响）。
// 文件：WA_PI_DIR/subagent-results/<toolCallId>.json，pi 侧 catch 分支轮询读取后
// 中转给父模型（见 wa-pi-bridge.extension.ts）。正常完成（无 abort）不落盘。

/** 快照目录：调用时读 env（测试以临时目录隔离；生产等价 shared 的 WA_PI_DIR 常量） */
function subagentResultsDir(): string {
	return join(process.env.WA_PI_DIR || WA_PI_DIR, "subagent-results");
}

/** 进度事件的 tools 分桶 → ToolStats（与 subagent-runner 的 toolStats() 同源算法） */
function toolStatsFromProgress(
	tools: ReadonlyArray<{ name: string; status: string }>,
): ToolStats {
	return {
		total: tools.length,
		done: tools.filter((t) => t.status === "done").length,
		error: tools.filter((t) => t.status === "error").length,
		running: tools.filter((t) => t.status === "running").length,
	};
}

/** 写中止快照 JSON。辅助中转通道：目录创建/写盘失败一律静默，不影响主流程 */
async function writeAbortSnapshot(
	toolCallId: string,
	payload: unknown,
): Promise<void> {
	try {
		const dir = subagentResultsDir();
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${toolCallId}.json`),
			JSON.stringify(payload),
			"utf8",
		);
	} catch {
		/* 静默失败：快照只是增强通道 */
	}
}

export function makeDelegateTool(opts: {
	askTo: DelegateTarget[];
	spawn: DelegateSpawnFn;
	/** 父会话 id：子代理实例目录（<WA_PI_DIR>/subagents/<父会话 id>/）的定位依据 */
	sessionId: string;
	/** 调用级信号槽（bridge 流式断连/用户停止时触发）：abort 瞬间写 final 快照。
	 *  与 makeSpawnFn 的 getCallSignal 同源（agent-manager 的 currentCallSignal 槽）。 */
	getCallSignal?: () => AbortSignal | undefined;
}) {
	const parentSessionId = opts.sessionId;
	// 中止即时快照的进度采集：key 为 toolCallId，值为该次派发各任务最近一条进度事件
	//（execute 进入时登记、finally 清理；notifyProgress 由注册点在 spawnFn onProgress 转发）
	const latestProgress = new Map<string, Map<number, SubagentProgressEvent>>();
	return {
		name: "delegate",
		label: "Delegate",
		description: DELEGATE_DESCRIPTION,
		parameters: DelegateParamsSchema,
		/** 进度采集入口（注册点转发 spawnFn onProgress）：供 abort 瞬间快照组装部分进度 */
		notifyProgress(toolCallId: string, event: SubagentProgressEvent): void {
			const byIndex = latestProgress.get(toolCallId);
			if (!byIndex) return;
			byIndex.set(event.taskIndex ?? 0, event);
		},
		async execute(
			toolCallId: string,
			args: { tasks: Array<{ agent: string; task: string; resume?: string }> },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details:
				| SubagentDetails
				/** 参数拒绝标记：任务数不合法（0 项或超过上限）时给出，无子代理明细
				 *  （显式声明缺失字段为 undefined，让调用侧访问 subagents/interrupted 不因联合变体报错） */
				| {
						subagents?: undefined;
						interrupted?: undefined;
						error: string;
				  }
				| undefined;
			isError: boolean;
			usage?: ReturnType<typeof sumPiToolUsage>;
		}> {
			// 任务数不合法（缺失/非数组/0 项/超上限）拒绝而非排队：排队会占住父代理的工具槽位且模型
			// 看不出「没并发」。不抛异常，与文件既有约定一致（错误经文本传达给 LLM）；
			// 入参来自模型/外部，tasks 缺失或非数组按 0 项处理，避免 args.tasks.length 抛 TypeError
			//（经 bridge catch 变成「Cannot read properties of undefined」这类不可读文本）
			const taskCount = Array.isArray(args.tasks) ? args.tasks.length : 0;
			if (taskCount === 0 || taskCount > MAX_SUBAGENT_CONCURRENCY) {
				return {
					content: [
						{
							type: "text" as const,
							text: `错误：tasks 需要 1..${MAX_SUBAGENT_CONCURRENCY} 项（当前 ${taskCount} 项）。`,
						},
					],
					details: { error: "delegate_task_count_invalid" },
					isError: true,
				};
			}

			// ── 中止快照：abort 瞬间用瞬时进度组装 final 立即落盘，settle 后覆盖 ──
			// resume 去重：同一次工具调用里两个任务续同一个实例会并发写同一份 jsonl
			// （历史互相覆盖），显式拒绝而不是排队
			const seenResume = new Set<string>();
			const callSignal = opts.getCallSignal?.();
			let aborted = callSignal?.aborted === true;
			let pendingImmediate: Promise<void> | undefined;
			latestProgress.set(toolCallId, new Map());
			const writeImmediateFinal = () => {
				aborted = true;
				const byIndex = latestProgress.get(toolCallId);
				// 每个子任务用其当时的 tools/output 瞬时快照组装（未 settle 同样处理，
				// 标题统一「（中断）」）；settle 后的覆盖写会替换为真实终态标记
				const lines = args.tasks.map((t, index) => {
					const ev = byIndex?.get(index);
					const note = ev ? buildPartialProgressNote(ev.tools, ev.output) : "";
					const body = note
						? `子智能体已被中止\n\n${note}`
						: "子智能体已被中止";
					return `【${t.agent}】（中断）\n${body}`;
				});
				// details 形状与 settle 后的完整快照一致：fleet 统计聚合自瞬时进度
				//（无进度事件的任务省略），interrupted 全 true
				const fleetStats: Record<string, ToolStats> = {};
				for (let index = 0; index < args.tasks.length; index++) {
					const ev = byIndex?.get(index);
					if (ev) fleetStats[String(index)] = toolStatsFromProgress(ev.tools);
				}
				const interrupted: Record<string, boolean> = {};
				for (let index = 0; index < args.tasks.length; index++) {
					interrupted[String(index)] = true;
				}
				pendingImmediate = writeAbortSnapshot(toolCallId, {
					toolCallId,
					tool: "delegate",
					phase: "final",
					text: lines.join("\n\n"),
					details: { fleet: fleetStats, interrupted },
					savedAt: new Date().toISOString(),
				});
			};
			if (callSignal) {
				if (callSignal.aborted) writeImmediateFinal();
				else
					callSignal.addEventListener("abort", writeImmediateFinal, {
						once: true,
					});
			}
			try {
				const results = await runWithConcurrency(
					args.tasks.map((t, index) => async () => {
						// ── resume 分支（规格 §6）──
						// 校验顺序：agentId 格式 → meta 存在 → status !== running → 同一子句内重复
						// resume 拒绝 → 类型以 meta.subagentType 为准 → 复用该实例的 jsonl。
						// 续聊不再做 askTo 越权校验：权限在首次派发时已校验过。
						if (t.resume) {
							try {
								assertAgentId(t.resume);
							} catch {
								return {
									index,
									agent: t.agent,
									// 非法 id 不当作实例句柄回显（原始串可能含 < & 破坏 XML，也误导模型复用）→ 置空降级
									agentId: "",
									jsonlPath: "",
									subagentType: t.agent,
									text: `错误：非法 agent_id「${t.resume}」`,
									isError: true,
									resumed: false,
									toolStats: undefined,
									usage: undefined,
									interrupted: undefined,
									elapsedMs: 0,
								};
							}
							// 去重必须**同步**且先于任何 await：runWithConcurrency 下若把 check+add 挪到
							// readMeta 之后，两个 thunk 会在该 await 处让出、双双漏检 → 并发写同一份 jsonl。
							// （并发硬约束，勿按字面顺序挪动）
							if (seenResume.has(t.resume)) {
								return {
									index,
									agent: t.agent,
									agentId: t.resume,
									jsonlPath: "",
									subagentType: t.agent,
									text: `错误：同一次调用里不能有两个任务续同一个子代理（${t.resume}）`,
									isError: true,
									resumed: false,
									toolStats: undefined,
									usage: undefined,
									interrupted: undefined,
									elapsedMs: 0,
								};
							}
							seenResume.add(t.resume);
							const meta = await readMeta(parentSessionId, t.resume);
							if (!meta) {
								return {
									index,
									agent: t.agent,
									agentId: t.resume,
									jsonlPath: "",
									subagentType: t.agent,
									text: `错误：子代理实例不存在（${t.resume}）`,
									isError: true,
									resumed: false,
									toolStats: undefined,
									usage: undefined,
									interrupted: undefined,
									elapsedMs: 0,
								};
							}
							if (meta.status === "running") {
								return {
									index,
									agent: t.agent,
									agentId: t.resume,
									jsonlPath: "",
									subagentType: meta.subagentType,
									text: `错误：子代理 ${t.resume} 正在运行，不能并发续聊`,
									isError: true,
									resumed: false,
									toolStats: undefined,
									usage: undefined,
									interrupted: undefined,
									elapsedMs: 0,
								};
							}
							// 类型以 meta 为准；jsonl 复用（t.task 由 pi 作为新一轮用户消息追加进同一份历史）
							const spawnAgent = meta.subagentType;
							const jsonl = jsonlPath(parentSessionId, t.resume);
							await selfHealStoredCwd(jsonl);
							const resumeCount = meta.resumeCount + 1;
							try {
								// meta 写盘走 safeWriteMeta（与新建路径同约定）：写失败仅告警，不把整个工具调用带崩
								await safeWriteMeta({
									...meta,
									status: "running",
									updatedAt: Date.now(),
									resumeCount,
								});
								const out = await opts.spawn(
									spawnAgent,
									t.task,
									toolCallId,
									index,
									jsonl,
								);
								await safeWriteMeta({
									...meta,
									status: out.interrupted
										? "interrupted"
										: out.isError
											? "failed"
											: "completed",
									updatedAt: Date.now(),
									resumeCount,
									usage: out.usage?.tokens
										? { ...out.usage.tokens, costTotal: out.usage.costTotal }
										: undefined,
									elapsedMs: out.elapsedMs,
									toolStats: out.toolStats,
								});
								return {
									index,
									agent: t.agent,
									agentId: t.resume,
									jsonlPath: jsonl,
									subagentType: spawnAgent,
									resumed: true,
									...out,
								};
							} catch (err) {
								// 单任务异常不连坐（同新建路径 :695-712）：spawn 闭包内 try 块外路径抛错时转
								// 结构化失败文本，其余任务继续执行、结果照常聚合不丢失。
								// meta 同步收尾为 interrupted：否则永久停在 running（此后 resume 全被误拒）
								const message = err instanceof Error ? err.message : String(err);
								await safeWriteMeta({
									...meta,
									status: "interrupted",
									updatedAt: Date.now(),
									resumeCount,
									elapsedMs: 0,
								});
								return {
									index,
									agent: t.agent,
									agentId: t.resume,
									jsonlPath: jsonl,
									subagentType: spawnAgent,
									text: `子智能体执行异常: ${message}`,
									isError: true,
									resumed: false,
									toolStats: undefined,
									usage: undefined,
									interrupted: true,
									elapsedMs: 0,
								};
							}
						}
						if (!canInvoke(t.agent, opts.askTo)) {
							// 越权调起：不建实例（无 meta、无转录），返回块的 agent_id / transcript 留空；
							// <type> 用请求名（未归一化——没进过 spawn）
							return {
								index,
								agent: t.agent,
								agentId: "",
								jsonlPath: "",
								subagentType: t.agent,
								text: buildNotAllowedMessage(t.agent, opts.askTo),
								isError: true,
								resumed: false,
								toolStats: undefined,
								usage: undefined,
								interrupted: undefined,
								elapsedMs: undefined,
							};
						}
						// 内置 subagent 中文别名（如"通用子智能体"）归一化为英文 name（"general-purpose"），
						// 让 spawn 闭包传给 subagent-runner 时能正确匹配 AgentDefinition
						const spawnAgent = normalizeSubagentType(t.agent);
						// 实例身份与转录路径在 spawn 前生成：pi 以 --session <路径> 直写这份 jsonl
						const agentId = newAgentId();
						let jsonl = "";
						try {
							jsonl = jsonlPath(parentSessionId, agentId);
						} catch (err) {
							// 父会话 id 非法（理论上不会：构造处传真实会话 id）→ 退化为不落盘
							//（spawn 收到空路径时走 --no-session），不阻断派发
							console.warn(
								`[delegate] 子代理转录路径不可用，本次不落盘（agentId=${agentId}）：${errorMessage(err)}`,
							);
						}
						// spawn 前显式建转录目录，与 meta 写入**解耦**：此前该目录的唯一创建者是
						// writeMeta 内部的 mkdir，失败被 safeWriteMeta 静默吞掉 → pi 收到指向不存在
						// 目录的 --session、返回块却宣告完整 <transcript>，模型 read 一个 404。
						// 这里失败不阻断派发，但降级为不落盘（jsonl 置空 → <transcript> 给空串）
						if (jsonl) {
							try {
								await mkdir(dirname(jsonl), { recursive: true });
							} catch (err) {
								console.warn(
									`[delegate] 子代理转录目录创建失败，本次不落盘（agentId=${agentId}）：${errorMessage(err)}`,
								);
								jsonl = "";
							}
						}
						const now = Date.now();
						// 身份/任务等不变字段：spawn 前后两次写 meta 共用
						const metaBase = {
							agentId,
							parentSessionId,
							toolCallId,
							taskIndex: index,
							subagentType: spawnAgent,
							requestedAgent: t.agent,
							task: t.task,
							createdAt: now,
							resumeCount: 0,
						};
						// spawn 前先落 running：中断/崩溃时 meta 不停在"不存在"，
						// 且 resume（任务 6）据此拒绝并发续写同一份 jsonl
						const metaPersisted = await safeWriteMeta({
							...metaBase,
							status: "running",
							updatedAt: now,
						});
						// meta 准备失败 = 该目录不可用 → 不宣告 <transcript>（避免模型 read 404）
						if (!metaPersisted) jsonl = "";
						// 所有子任务共享同一个 delegate 工具调用的 toolCallId：前端卡片靠它定位，
						// 内部按 progress.taskIndex 区分各子任务
						try {
							const { text, isError, toolStats, usage, interrupted, elapsedMs } =
								await opts.spawn(spawnAgent, t.task, toolCallId, index, jsonl);
							// 终态落盘：usage 用扁平形状（SubagentUsageShape），拆包后审计/列表直接读
							await safeWriteMeta({
								...metaBase,
								status: interrupted
									? "interrupted"
									: isError
										? "failed"
										: "completed",
								updatedAt: Date.now(),
								usage: usage?.tokens
									? { ...usage.tokens, costTotal: usage.costTotal }
									: undefined,
								elapsedMs,
								toolStats,
							});
							return {
								index,
								agent: t.agent,
								agentId,
								jsonlPath: jsonl,
								subagentType: spawnAgent,
								text,
								isError,
								resumed: false,
								toolStats,
								usage,
								interrupted,
								elapsedMs,
							};
						} catch (err) {
							// 单任务意外异常不连坐：spawn 闭包内 try 块外的路径（resolveConfig /
							// ensureExtension 等）抛错时转结构化失败（对齐 subagent-runner 异常路径
							// 语义：isError + interrupted），其余任务继续执行、结果照常聚合不丢失。
							// meta 同步收尾为 interrupted：否则永久停在 running（resume 误拒、列表误报运行中）
							const message = err instanceof Error ? err.message : String(err);
							await safeWriteMeta({
								...metaBase,
								status: "interrupted",
								updatedAt: Date.now(),
								elapsedMs: 0,
							});
							return {
								index,
								agent: t.agent,
								agentId,
								jsonlPath: jsonl,
								subagentType: spawnAgent,
								text: `子智能体执行异常: ${message}`,
								isError: true,
								resumed: false,
								toolStats: undefined,
								usage: undefined,
								interrupted: true,
								elapsedMs: 0,
							};
						}
					}),
					MAX_SUBAGENT_CONCURRENCY,
				);
				// ── 返回块：XML、标签同行、多项之间单换行（规格 §7）──
				const blocks = results.map((r) =>
					renderSubagentBlock({
						taskIndex: r.index,
						agentId: r.agentId,
						subagentType: r.subagentType,
						status: r.interrupted
							? "interrupted"
							: r.isError
								? "failed"
								: "completed",
						elapsedMs: r.elapsedMs,
						totalTokens: r.usage?.tokens.total,
						resumed: r.resumed,
						jsonlPath: r.jsonlPath,
						text: r.text,
					}),
				);
				const details: SubagentDetails = {
					subagents: results.map((r) => ({
						taskIndex: r.index,
						agentId: r.agentId,
						agent: r.agent,
						subagentType: r.subagentType,
						resumed: r.resumed,
						status: r.interrupted
							? "interrupted"
							: r.isError
								? "failed"
								: "completed",
						elapsedMs: r.elapsedMs,
						usage: r.usage,
						toolStats: r.toolStats,
						interrupted: r.interrupted === true,
					})),
					interrupted: results.some((r) => r.interrupted === true),
				};
				if (aborted) {
					// settle 后用最终状态覆盖写 final；先等 abort 瞬间的写盘完成
					await pendingImmediate;
					// 快照（subagent-results/）本次不动（规格 §10）：它的 text/details 沿用旧
					// 【agent】+ fleet 形状，前端按旧数据兼容路径渲染（与新返回块并存）
					const lines = results.map((r) => {
						const marks = [r.isError ? "失败" : "", r.interrupted ? "中断" : ""]
							.filter(Boolean)
							.join("·");
						return `【${r.agent}】${marks ? `（${marks}）` : ""}\n${r.text}`;
					});
					const fleetStats: Record<string, ToolStats> = {};
					const fleetInterrupted: Record<string, boolean> = {};
					for (const r of results) {
						if (r.toolStats) fleetStats[String(r.index)] = r.toolStats;
						fleetInterrupted[String(r.index)] = r.interrupted === true;
					}
					await writeAbortSnapshot(toolCallId, {
						toolCallId,
						tool: "delegate",
						phase: "final",
						text: lines.join("\n\n"),
						details: { fleet: fleetStats, interrupted: fleetInterrupted },
						savedAt: new Date().toISOString(),
					});
				}
				return {
					content: [{ type: "text" as const, text: blocks.join("\n") }],
					details,
					isError: results.some((r) => r.isError),
					// 各子代理用量聚合上报：pi 官方 stats 原生计入累计（usage reported by tools）
					usage: sumPiToolUsage(results.map((r) => r.usage)),
				};
			} finally {
				latestProgress.delete(toolCallId);
				callSignal?.removeEventListener("abort", writeImmediateFinal);
			}
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
	/** 调用级信号槽（bridge 流式断连时由 ws-server 触发）：
	 *  与 opts.signal（会话级）叠加，任一触发都中止本次派发的子代理。
	 *  每次派发时调用取值——同一 spawnFn 服务多次工具调用，信号是每次调用不同的。 */
	getCallSignal?: () => AbortSignal | undefined;
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
	// 闭包接受 toolCallId（来自 delegate execute 透传），用于把 onProgress 关联到正确卡片
	return async (
		agent: string,
		task: string,
		toolCallId: string,
		taskIndex?: number,
		sessionFile?: string,
	) => {
		const config = await opts.resolveConfig(agent);
		if (!config) {
			// elapsedMs: 0 而非缺省：返回块要渲染 <elapsed>，0 明确表达「没跑」
			const result = {
				text: `智能体「${agent}」配置未找到`,
				isError: true,
				elapsedMs: 0,
			};
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
		// 叠加调用级信号（bridge 断连）：与外层会话级 signal 任一触发都中止本次派发
		const callSignal = opts.getCallSignal?.();
		if (callSignal) {
			if (callSignal.aborted) controller.abort();
			else
				callSignal.addEventListener("abort", () => controller.abort(), {
					once: true,
				});
		}
		// 实例 id：转录路径由 delegate-tool 按 <agentId>.jsonl 命名，这里从文件名反解，
		// 供进度事件携带（前端把运行中的进度关联到具体子代理实例，规格 §9.1）。
		// 空路径（未要求落盘）时缺省，事件不带 agentId。
		const agentId = sessionFile ? basename(sessionFile, ".jsonl") : undefined;
		try {
			const result = await runSubagent(config, task, opts.cwd, {
				signal: controller.signal,
				// 把外层 onProgress(toolCallId, event) 包一层：runSubagentAgent 内部仍以
				// (event) => void 调用，这里注入闭包捕获的 toolCallId + agentId，
				// 实现进度帧关联卡片与实例
				onProgress: opts.onProgress
					? (event) =>
							opts.onProgress!(toolCallId, { ...event, taskIndex, agentId })
					: undefined,
				// 转录落盘：pi --session <路径>（未传则 runSubagent 回退 --no-session）
				sessionFile,
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
				// 非正常终态标记与工具统计透传遥测（正常完成也带 toolStats）
				interrupted: result.interrupted,
				toolStats: result.toolStats,
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
