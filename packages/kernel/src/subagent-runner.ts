// subagent-runner.ts — 一次性 pi rpc 子进程执行子智能体（wa-pi 自实现，
// 不依赖 pi-open-agents：kernel 直接 spawn 临时 `pi --mode rpc --no-session`
// 子进程，发送任务 → 收集事件流转进度 → agent_settled 后取最终回复 → 销毁进程）。
//
// 职责：
// 1. 把 WaPiSpawnConfig 翻译成 pi CLI 参数（--system-prompt/--tools/--skill/--model/--thinking）
// 2. 事件流映射为 SubagentProgressEvent（工具调用状态 + 累计文本 + 耗时）
// 3. 所有失败路径收敛为 { text, isError:true }，绝不 throw

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	SubagentProgressEvent,
	ThinkingLevel,
	ToolStats,
} from "@wa-pi/shared";
import { WA_PI_DIR } from "@wa-pi/shared";
import {
	RpcClient,
	buildPiArgs,
	resolvePiCliPath,
	resolvePiRuntime,
	type RpcEvent,
} from "./rpc-client";
import { composeSubagentPrompt } from "./system-prompt";

/** WaPi 侧的 agent 配置片段（从 AgentConfig 提取） */
export interface WaPiSpawnConfig {
	name: string;
	description: string;
	systemPrompt: string;
	model: string | null;
	thinking: ThinkingLevel | null;
	tools: string[];
	skills: string[];
	/** 显式全不选技能（delegate/fleet 子代理不加载任何技能，传空数组） */
	skillsAllOff?: boolean;
}

/** 子代理会话 token 用量（pi get_session_stats 采集，用于派发遥测） */
export interface SubagentUsage {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	costTotal: number;
}

/** 执行结果（与 delegate-tool 的 DelegateSpawnResult 对齐） */
export interface SubagentRunResult {
	text: string;
	isError: boolean;
	/** 结构化中断标记：子代理被中止/探活超时/settle 超时/异常提前终止（未正常跑完）时为 true；
	 *  正常完成与模型终态失败（sawError）不标记（undefined）。isError 语义不变，
	 *  前端据此区分「中断」与普通失败 */
	interrupted?: boolean;
	/** 子代理 token 用量；采集失败（如旧版 pi 不支持）时降级为 undefined */
	usage?: SubagentUsage;
	/** 子代理工具调用统计（与实时 progress 的 tools 分桶同源）；异常路径（如进程启动失败）时为 undefined */
	toolStats?: ToolStats;
	elapsedMs: number;
}

/** 部分进度段步骤条数上限：超过折叠为「等 N 项」 */
const PARTIAL_STEPS_LIMIT = 30;
/** 部分进度段输出片段字符上限（取尾部） */
const PARTIAL_OUTPUT_LIMIT = 4000;
/** 单条工具产出留存字符上限：超长截断（防单条巨结果撑爆进度帧与快照） */
const TOOL_RESULT_LIMIT = 800;
/** 工具产出留存总量字符上限：超限丢最旧；fleet 每个子任务独立适用（各自 tools 数组） */
const TOOL_RESULTS_TOTAL_LIMIT = 16 * 1024;
/** 部分进度「关键产出摘录」段条数上限 */
const PARTIAL_EXCERPTS_LIMIT = 10;
/** 单条摘录展示字符上限（首行截断） */
const EXCERPT_LIMIT = 200;

/**
 * 组装「部分进度」段：子代理被中止/超时/异常提前终止时，把过程中已产生的工具调用
 * 统计、产出摘录与输出尾部附在返回 text 里，让父模型看到子代理已完成的工作（而非全部丢弃）。
 * tools 条目只有工具名（无目标描述），只列工具名、不臆造内容；result 为可选的产出
 * 留存文本（tool_execution_end 时经 retainToolResult 截断留存），有则追加「关键产出摘录」段
 * （仅 done 工具，最多 10 条）。
 * 无任何可保留信息（无工具且无输出）时返回空串，调用方不附加段落。
 */
export function buildPartialProgressNote(
	tools: ReadonlyArray<{ name: string; status: string; result?: string }>,
	output: string,
): string {
	const done = tools.filter((t) => t.status === "done").length;
	const error = tools.filter((t) => t.status === "error").length;
	const running = tools.filter((t) => t.status === "running").length;
	const lines: string[] = [];
	if (tools.length > 0) {
		lines.push(
			`部分进度：工具调用 ${tools.length} 个（成功 ${done} / 失败 ${error} / 中断 ${running}）。`,
		);
		// 步骤列表：工具名 + 状态符号（✅ 成功 / ❌ 失败 / ⏸ 执行中被中断）；
		// 最多 30 条，超出折叠为「等 N 项」
		const marks: Record<string, string> = {
			done: "✅",
			error: "❌",
			running: "⏸",
		};
		const steps = tools
			.slice(0, PARTIAL_STEPS_LIMIT)
			.map((t) => `${t.name} ${marks[t.status] ?? "⏸"}`)
			.join("、");
		const folded =
			tools.length > PARTIAL_STEPS_LIMIT ? ` 等 ${tools.length} 项` : "";
		lines.push(`已完成步骤：${steps}${folded}`);
		// 关键产出摘录：已完成工具（done）的产出首行，最多 10 条——
		// 让父模型看到「做出了什么」而不只是「做了几件」
		const excerpts = tools
			.filter((t) => t.status === "done" && t.result)
			.slice(0, PARTIAL_EXCERPTS_LIMIT);
		if (excerpts.length > 0) {
			lines.push("关键产出摘录：");
			for (const t of excerpts) {
				lines.push(`- ${t.name}：${excerptFirstLine(t.result ?? "")}`);
			}
		}
	}
	const trimmed = output.trim();
	if (trimmed) {
		// 只取尾部：中断前的最后输出最有参考价值；超长时以「…」标记前文截断
		const tail =
			trimmed.length > PARTIAL_OUTPUT_LIMIT
				? `…${trimmed.slice(-PARTIAL_OUTPUT_LIMIT)}`
				: trimmed;
		lines.push(`最后输出片段：${tail}`);
	}
	return lines.join("\n");
}

/** 摘录文本：取首行（trim 后），超长截断加省略号；首行为空（以换行开头）退化为截断全文 */
function excerptFirstLine(text: string): string {
	const trimmed = text.trim();
	const first = trimmed.split("\n", 1)[0] || trimmed;
	return first.length > EXCERPT_LIMIT
		? `${first.slice(0, EXCERPT_LIMIT)}…`
		: first;
}

/** 从工具结果提取文本：result 可能是字符串或含 content 数组的对象（content
 *  条目取 {type:"text",text}，与 pi 工具结果形状对齐），取不到返回空串（跳过留存） */
function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(c): c is { type: "text"; text: string } =>
						!!c &&
						typeof c === "object" &&
						(c as { type?: unknown }).type === "text" &&
						typeof (c as { text?: unknown }).text === "string",
				)
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

/** 留存工具产出文本：写入条目 result（单条截断 TOOL_RESULT_LIMIT）并做总量控制
 *  （超 TOOL_RESULTS_TOTAL_LIMIT 从最旧丢弃），独立导出便于测试两级截断 */
export function retainToolResult(
	list: Array<{ id: string; name: string; status: string; result?: string }>,
	id: string,
	text: string,
): void {
	const target = list.find((x) => x.id === id);
	if (!target || !text) return;
	target.result =
		text.length > TOOL_RESULT_LIMIT ? text.slice(0, TOOL_RESULT_LIMIT) : text;
	let total = 0;
	for (const t of list) total += t.result?.length ?? 0;
	for (const t of list) {
		if (total <= TOOL_RESULTS_TOTAL_LIMIT) break;
		if (t.result) {
			total -= t.result.length;
			delete t.result;
		}
	}
}

export interface SubagentRunOpts {
	signal?: AbortSignal;
	onProgress?: (event: SubagentProgressEvent) => void;
	/** 已解析为目录路径的技能白名单（空 = 不传 --skill，pi 默认发现） */
	skillPaths?: string[];
	/** 随子进程加载的扩展文件（-e），如 pi-web-access / provider-extension；空 = 不传 */
	extensionPaths?: string[];
	/** 测试覆盖：pi CLI 入口 / 运行时 */
	cliPath?: string;
	runtime?: string;
	/** RPC 命令超时毫秒数，默认 2 小时（7200000，用户拍板 2026-08-31 由 60 分钟增长）；设为 Infinity 关闭超时（settle 兜底同样跳过） */
	commandTimeoutMs?: number;
	/** 无进展探活超时毫秒数，默认 10 分钟（600000）。进程存活但无任何业务事件
	 *  （message_update / tool_execution_* / agent_start|end / thinking_delta）
	 *  超过该时长判定卡死。工具执行中同样不豁免：正常长工具（bash 等）会持续发
	 *  tool_execution_update 流式输出刷新计时；完全静默（含等工具返回）超时判死——
	 *  没有任何进展的静默本身就是卡死信号。设为 Infinity 关闭探活。 */
	idleTimeoutMs?: number;
	/** abort 宽限期毫秒数（测试覆盖用）：收到中止信号后等子代理响应 abort RPC 的时长，
	 *  到期强制返回并由 finally dispose 强杀进程。默认 10000 */
	abortGraceMs?: number;
}

/** abort 宽限期默认值：收到中止信号后等子代理响应 abort RPC 的时间，
 *  到期不再等待 settle，走 finally dispose 强杀（防用户停止后子代理后台再活满 settle 超时） */
export const ABORT_GRACE_MS = 10_000;

/** RPC 命令 / settle 兜底默认超时：子代理委托整体硬上限，默认 2 小时（用户拍板 2026-08-31，由 60 分钟增长：长任务单代理实测可跑 39-50 分钟，60 分钟余量不足）。 */
export const COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;

/** 无进展探活默认超时：子代理进程存活但 10 分钟无任何业务事件判定卡死。 */
export const LIVENESS_IDLE_MS = 10 * 60_000;

/**
 * thinking → pi CLI thinking level 映射。
 * - disabled → off（完全关闭推理）
 * - max → xhigh（最大推理深度）
 * - minimal → minimal
 *   minimal：最低推理强度，仅关键决策时启用思考，其余直接输出。
 *   适用于简单工具调用等低认知负载场景，平衡速度与质量。
 *   典型场景：读取已知路径下的配置文件查单个值、执行单条命令、
 *   简单的 grep 查询等确定性任务，不需要模型展开完整推理链。
 *   效果：token 消耗低、响应快，但面对复杂推理任务可能质量下降。
 * - medium / high → 直接透传
 */
function mapThinking(thinking: ThinkingLevel | null): string | undefined {
	if (!thinking) return undefined;
	return thinking === "disabled"
		? "off"
		: thinking === "max"
			? "xhigh"
			: thinking; // minimal／medium／high 直接透传
}

/**
 * 执行子智能体：spawn 一次性 pi rpc 子进程跑完 task 并取回最终文本。
 * onProgress 回调实时转发工具调用/文本输出。
 * 所有失败路径收敛为 { text, isError:true }，绝不 throw。
 */
export async function runSubagentAgent(
	config: WaPiSpawnConfig,
	task: string,
	cwd: string,
	opts?: SubagentRunOpts,
): Promise<SubagentRunResult> {
	const startedAt = Date.now();
	// 子代理系统提示词临时文件（pi 的 --system-prompt 支持文件路径，规避命令行长度限制）。
	// 无条件创建：即使 systemPrompt 为空也要注入自我保护段（composeSubagentPrompt 空正文兜底），
	// 否则空提示词子代理完全无约束却跳过保护段注入。
	const tmpDir = join(WA_PI_DIR, "tmp", "subagent-prompts");
	const promptFile = join(tmpDir, `${config.name}-${randomUUID()}.md`);

	let client: RpcClient | null = null;
	// 进度状态累积（提升到 try 外：中止/探活超时/settle 超时/异常等非正常终态路径
	// 也要用 tools/output 组装「部分进度」段，不再丢弃过程中产生的数据）；
	// result 为工具产出留存文本（retainToolResult 截断留存）
	const tools: Array<{
		id: string;
		name: string;
		status: string;
		result?: string;
	}> = [];
	let output = "";
	const toolStats = (): ToolStats => ({
		total: tools.length,
		done: tools.filter((t) => t.status === "done").length,
		error: tools.filter((t) => t.status === "error").length,
		running: tools.filter((t) => t.status === "running").length,
	});
	try {
		await mkdir(tmpDir, { recursive: true });
		await writeFile(
			promptFile,
			composeSubagentPrompt(config.systemPrompt),
			"utf8",
		);

		let sawError = false;
		const emit = (status: SubagentProgressEvent["status"]) => {
			opts?.onProgress?.({
				agent: config.name,
				status,
				output,
				tools: tools.map((t) => ({ ...t })),
				elapsedMs: Date.now() - startedAt,
			});
		};

		// agent_settled 时兑现；进程提前退出 / 出错时 reject
		let settle: () => void;
		let fail: (err: Error) => void;
		const settled = new Promise<void>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// 进程提前退出时 fail() 会 reject settled，但 prompt 可能先一步抛错使 settled 无人 await
		// （unhandled rejection）。挂空 catch 兜底；await settled 处仍能拿到原 rejection。
		settled.catch(() => {});

		// 无进展探活（防卡死）：任何业务事件刷新计时，超过 idleTimeoutMs 无事件判死。
		// 无工具执行豁免：tool_execution_update（长工具流式输出）/ message_update /
		// thinking_delta 都是进展，会刷新计时；完全静默（含等工具返回）超时判死。
		const idleTimeoutMs = opts?.idleTimeoutMs ?? LIVENESS_IDLE_MS;
		let livenessTimer: ReturnType<typeof setTimeout> | undefined;
		const armLiveness = () => {
			if (livenessTimer) clearTimeout(livenessTimer);
			livenessTimer = setTimeout(() => {
				fail(new Error(`子智能体无进展超时 (${idleTimeoutMs}ms)`));
			}, idleTimeoutMs);
		};
		const touch = () => {
			if (Number.isFinite(idleTimeoutMs)) armLiveness();
		};

		const onEvent = (e: RpcEvent) => {
			switch (e.type) {
				case "agent_start":
				case "agent_end":
					touch();
					break;
				case "tool_execution_start":
					touch();
					tools.push({ id: e.toolCallId, name: e.toolName, status: "running" });
					emit("running");
					break;
				case "tool_execution_update":
					// 长运行工具的 partialResult 流式输出（如 bash 逐行到达）= 有进展，
					// 刷新探活计时；工具仍在执行中（status 不变 running，无需额外 emit）。
					touch();
					break;
				case "tool_execution_end": {
					touch();
					const t = tools.find((x) => x.id === e.toolCallId);
					if (t) t.status = e.isError ? "error" : "done";
					// 留存工具产出文本（单条 800 / 总量 16KB 截断）：供部分进度
					//「关键产出摘录」段与 abort 瞬间快照使用；取不到文本则跳过
					retainToolResult(
						tools,
						e.toolCallId,
						extractToolResultText(e.result),
					);
					emit("running");
					break;
				}
				case "message_update": {
					touch();
					const delta = e.assistantMessageEvent;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						output += delta.delta;
						emit("running");
					}
					break;
				}
				case "message_end": {
					touch();
					const msg = e.message;
					if (msg?.role === "assistant" && msg?.stopReason === "error")
						sawError = true;
					break;
				}
				case "agent_settled":
					touch();
					settle();
					break;
			}
		};

		client = new RpcClient({
			cliPath: opts?.cliPath ?? resolvePiCliPath(),
			runtime: opts?.runtime ?? resolvePiRuntime(),
			args: buildPiArgs({
				noSession: true,
				systemPromptFile: promptFile ?? undefined,
				extensionPaths: opts?.extensionPaths,
				skillPaths: opts?.skillPaths,
				noSkills: true, // 子代理不自动发现技能，只加载显式传入的 --skill 路径
				offline: true,
				tools: config.tools.length > 0 ? config.tools : undefined,
				thinking: mapThinking(config.thinking),
				model: config.model ?? undefined,
				name: config.name,
			}),
			cwd,
			env: { PI_CODING_AGENT_DIR: WA_PI_DIR },
			commandTimeoutMs: opts?.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
			onEvent,
			onExit: (code) => {
				// agent_settled 前退出视为失败（settled 后 dispose 的正常退出不走这里：
				// dispose 前先移除监听，见下方 finally）
				fail(new Error(`子智能体进程提前退出 (code=${code})`));
			},
		});
		await client.start();

		// 中止信号：abort 命令 + 随后进程销毁在 finally 统一处理
		const onAbort = () => {
			client?.abort().catch(() => {});
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await client.prompt(task);
			// settled 超时兜底：子代理 pi 若卡死（永不发 agent_settled 也不退出），
			// 超时后 reject → 走 finally dispose 回收进程。否则 await settled 永久阻塞，
			// 进程泄漏累积 → macOS SIGKILL（历史 bug）。
			// Infinity 显式关闭超时：setTimeout(Infinity) 在 Node/Bun 溢出按 1ms 处理，
			// 会直接误超时，必须 Number.isFinite 特判跳过。
			const settleTimeoutMs = opts?.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
			const abortGraceMs = opts?.abortGraceMs ?? ABORT_GRACE_MS;
			let settleTimer: ReturnType<typeof setTimeout> | undefined;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const racers: Promise<void>[] = [settled];
			if (Number.isFinite(settleTimeoutMs)) {
				racers.push(
					new Promise<never>((_, reject) => {
						settleTimer = setTimeout(
							() => reject(new Error(`子智能体 settle 超时 (${settleTimeoutMs}ms)`)),
							settleTimeoutMs,
						);
					}),
				);
			}
			if (Number.isFinite(idleTimeoutMs)) {
				racers.push(
					new Promise<never>(() => {
						armLiveness(); // fire 时内部用 fail() 判死（含工具执行中豁免重置）
					}),
				);
			}
			// abort 短路：子代理可能卡在不可中断的工具里收不到 abort RPC，若仍等
			// settle 超时（默认 60 分钟），用户点停止后子代理进程在后台继续存活烧配额。
			// 宽限 abortGraceMs 等子代理响应 abort，到期 resolve —— 走下方
			// signal.aborted 分支返回「子智能体已被中止」，finally dispose 强杀进程。
			if (opts?.signal) {
				const sig = opts.signal;
				racers.push(
					new Promise<void>((resolve) => {
						const arm = () => {
							graceTimer = setTimeout(resolve, abortGraceMs);
						};
						if (sig.aborted) arm();
						else sig.addEventListener("abort", arm, { once: true });
					}),
				);
			}
			try {
				await Promise.race(racers);
			} finally {
				// settle 先兑现时清理两个计时器，防长期高频派发累积挂起计时器
				if (settleTimer !== undefined) clearTimeout(settleTimer);
				if (graceTimer !== undefined) clearTimeout(graceTimer);
				if (livenessTimer !== undefined) clearTimeout(livenessTimer);
			}
		} finally {
			opts?.signal?.removeEventListener("abort", onAbort);
		}

		if (opts?.signal?.aborted) {
			// 非正常终态：附加部分进度段（无过程数据时 note 为空串，不附加）
			const note = buildPartialProgressNote(tools, output);
			return {
				text: note ? `子智能体已被中止\n\n${note}` : "子智能体已被中止",
				isError: true,
				interrupted: true,
				toolStats: toolStats(),
				elapsedMs: Date.now() - startedAt,
			};
		}

		// 最终文本：优先取最后一条 assistant 文本（比流式累积更完整）
		let text = output;
		try {
			const last = await client.command({ type: "get_last_assistant_text" });
			if (typeof last?.text === "string" && last.text.trim()) text = last.text;
		} catch {
			/* 取不到则用流式累积 */
		}

		// 遥测：取子代理会话 token 用量（dispose 前一次性查询；不支持则降级 undefined）
		let usage: SubagentUsage | undefined;
		try {
			const stats = await client.getSessionStats();
			const t = stats?.tokens;
			if (t) {
				usage = {
					tokens: {
						input: t.input ?? 0,
						output: t.output ?? 0,
						cacheRead: t.cacheRead ?? 0,
						cacheWrite: t.cacheWrite ?? 0,
						total: t.total ?? 0,
					},
					// pi SessionStats.cost 可能是数值或 { total } 对象，防御性兼容
					costTotal:
						typeof stats?.cost === "number" ? stats.cost : (stats?.cost?.total ?? 0),
				};
			}
		} catch {
			/* 采集失败不影响主流程 */
		}

		const elapsedMs = Date.now() - startedAt;
		if (sawError) {
			return {
				text: text || "子智能体模型调用失败",
				isError: true,
				usage,
				toolStats: toolStats(),
				elapsedMs,
			};
		}
		emit("done");
		return {
			text: text || "（子智能体无输出）",
			isError: false,
			usage,
			toolStats: toolStats(),
			elapsedMs,
		};
	} catch (err) {
		// 探活超时 / settle 超时 / 进程提前退出等经 fail() 汇聚到这里：
		// 同样属于非正常终态，附加部分进度段并标 interrupted（tools/output 已提升到 try 外可访问）
		const message = err instanceof Error ? err.message : String(err);
		const note = buildPartialProgressNote(tools, output);
		return {
			text: note
				? `子智能体执行失败: ${message}\n\n${note}`
				: `子智能体执行失败: ${message}`,
			isError: true,
			interrupted: true,
			toolStats: toolStats(),
			elapsedMs: Date.now() - startedAt,
		};
	} finally {
		if (client) {
			// 防止 dispose 的正常 kill 触发 onExit 的 fail（settled 已兑现则无影响，防御性处理）
			const c = client;
			client = null;
			await c.dispose().catch(() => {});
		}
		if (promptFile) {
			await rm(promptFile, { force: true }).catch(() => {});
		}
	}
}
