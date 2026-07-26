// subagent-runner.ts — 一次性 pi rpc 子进程执行子智能体
//
// RPC 迁移后不再经过 pi-open-agents 的 runSubagent（SDK 形态），
// 改为 kernel 直接 spawn 一个临时 `pi --mode rpc --no-session` 子进程：
// 发送任务 → 收集事件流转进度 → agent_settled 后取最终回复 → 销毁进程。
//
// 职责：
// 1. 把 HiAgentSpawnConfig 翻译成 pi CLI 参数（--system-prompt/--tools/--skill/--model/--thinking）
// 2. 事件流映射为 SubagentProgressEvent（工具调用状态 + 累计文本 + 耗时）
// 3. 所有失败路径收敛为 { text, isError:true }，绝不 throw

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@hiagent/shared";
import { HIAGENT_DIR } from "@hiagent/shared";
import {
	RpcClient,
	buildPiArgs,
	resolvePiCliPath,
	resolvePiRuntime,
	type RpcEvent,
} from "./rpc-client";

/** HiAgent 侧的 agent 配置片段（从 AgentConfig 提取） */
export interface HiAgentSpawnConfig {
	name: string;
	description: string;
	systemPrompt: string;
	systemPromptMode: "replace" | "append";
	model: string | null;
	thinking: ThinkingLevel | null;
	tools: string[];
	skills: string[];
}

/** 过程事件：转发给 agent-manager → WS → 前端 */
export interface SubagentProgressEvent {
	agent: string;
	status: "running" | "done" | "error";
	output: string;
	tools: Array<{ id: string; name: string; status: string }>;
	elapsedMs: number;
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
	/** 子代理 token 用量；采集失败（如旧版 pi 不支持）时降级为 undefined */
	usage?: SubagentUsage;
	elapsedMs: number;
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
	/** RPC 命令超时毫秒数，默认 30 分钟（1800000）；设为 Infinity 可无限等待 */
	commandTimeoutMs?: number;
}

/** thinking → pi CLI thinking level 映射（disabled→off，max→xhigh，其余透传） */
function mapThinking(thinking: ThinkingLevel | null): string | undefined {
	if (!thinking) return undefined;
	return thinking === "disabled"
		? "off"
		: thinking === "max"
			? "xhigh"
			: thinking;
}

/**
 * 执行子智能体：spawn 一次性 pi rpc 子进程跑完 task 并取回最终文本。
 * onProgress 回调实时转发工具调用/文本输出。
 * 所有失败路径收敛为 { text, isError:true }，绝不 throw。
 */
export async function runSubagentAgent(
	config: HiAgentSpawnConfig,
	task: string,
	cwd: string,
	opts?: SubagentRunOpts,
): Promise<SubagentRunResult> {
	const startedAt = Date.now();
	// 子代理系统提示词临时文件（pi 的 --system-prompt 支持文件路径，规避命令行长度限制）
	const tmpDir = join(HIAGENT_DIR, "tmp", "subagent-prompts");
	const promptFile = config.systemPrompt
		? join(tmpDir, `${config.name}-${randomUUID()}.md`)
		: null;

	let client: RpcClient | null = null;
	try {
		if (promptFile) {
			await mkdir(tmpDir, { recursive: true });
			await writeFile(promptFile, config.systemPrompt, "utf8");
		}

		// 进度状态累积
		const tools: Array<{ id: string; name: string; status: string }> = [];
		let output = "";
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

		const onEvent = (e: RpcEvent) => {
			switch (e.type) {
				case "tool_execution_start":
					tools.push({ id: e.toolCallId, name: e.toolName, status: "running" });
					emit("running");
					break;
				case "tool_execution_end": {
					const t = tools.find((x) => x.id === e.toolCallId);
					if (t) t.status = e.isError ? "error" : "done";
					emit("running");
					break;
				}
				case "message_update": {
					const delta = e.assistantMessageEvent;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						output += delta.delta;
						emit("running");
					}
					break;
				}
				case "message_end": {
					const msg = e.message;
					if (msg?.role === "assistant" && msg?.stopReason === "error")
						sawError = true;
					break;
				}
				case "agent_settled":
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
				tools: config.tools.length > 0 ? config.tools : undefined,
				thinking: mapThinking(config.thinking),
				model: config.model ?? undefined,
				name: config.name,
			}),
			cwd,
			env: { PI_CODING_AGENT_DIR: HIAGENT_DIR },
			commandTimeoutMs: opts?.commandTimeoutMs ?? 1_800_000,
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
			await settled;
		} finally {
			opts?.signal?.removeEventListener("abort", onAbort);
		}

		if (opts?.signal?.aborted) {
			return {
				text: "子智能体已被中止",
				isError: true,
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
						typeof stats?.cost === "number"
							? stats.cost
							: (stats?.cost?.total ?? 0),
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
				elapsedMs,
			};
		}
		emit("done");
		return {
			text: text || "（子智能体无输出）",
			isError: false,
			usage,
			elapsedMs,
		};
	} catch (err) {
		return {
			text: `子智能体执行失败: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
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
