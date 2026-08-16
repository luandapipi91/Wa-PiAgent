// SPDX-License-Identifier: MIT
// wa-pi-bridge.extension.ts —— WaPi RPC 模式宿主工具桥（静态扩展文件）
//
// 本文件由 ensureBridgeExtension() 复制到 GENERATED_DIR/wa-pi-bridge.ts，
// Pi 进程经 -e 加载。所有工具的 execute 经 HTTP 回调 kernel 的 /bridge/tool 端点。
//
// 工具文案与 Schema 来源于 @wa-pi/shared/tool-schemas.ts（复制到同目录下）。
// 不再动态生成——文案统一来源，kernel 侧与 bridge 侧引用同一份定义。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ASK_DESCRIPTION,
	ASK_PROMPT_GUIDELINES,
	AskParamsSchema,
	MEM_TARGET_DESC,
	MEM_SCOPE_DESC,
	MEM_ADD_DESC,
	MEM_ADD_SNIPPET,
	MEM_REPLACE_DESC,
	MEM_REPLACE_SNIPPET,
	MEM_REMOVE_DESC,
	MEM_REMOVE_SNIPPET,
	MEM_READ_DESC,
	MEM_READ_SNIPPET,
	MemoryTargetSchema,
	MemoryScopeSchema,
	DELEGATE_DESCRIPTION,
	DelegateParamsSchema,
	FLEET_DESCRIPTION,
	FleetParamsSchema,
} from "./tool-schemas.ts";

// =========================================================================
// kernel spawn pi 时注入的三个环境变量
// =========================================================================

const BRIDGE_URL = process.env.WA_PI_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.WA_PI_BRIDGE_TOKEN;
const BRIDGE_SESSION_ID = process.env.WA_PI_SESSION_ID;

const DEFAULT_TIMEOUT_MS = 60_000; // 普通工具 60s
const ASK_TIMEOUT_MS = 600_000; // ask 等用户回答，放宽到 10 分钟
const DELEGATE_TIMEOUT_MS = 600_000; // delegate/fleet：10 分钟无任何帧才判死（流式后"无帧"才是真卡死）

// bridge 偶发断开重试：pi 侧 fetch 的 socket 可能被 Bun 非确定性清理（GC/keep-alive），
// 断开后重试能恢复长连接（ask 等用户回答期间尤其需要）。重试前校验 signal 未 abort
// （ask 仍有效），避免用户已取消/工具已中止时无谓重试。
const MAX_BRIDGE_RETRIES = 5;
const BRIDGE_RETRY_DELAY_MS = 1_000;

type BridgeToolResult = {
	content: Array<{ type: "text"; text: string }>;
	// pi 0.82 起 AgentToolResult.details 为必填（类型层面对齐；运行期 undefined 行为不变）
	details: unknown;
};

function missingEnvError(): string | null {
	if (!BRIDGE_URL || !BRIDGE_TOKEN || !BRIDGE_SESSION_ID) {
		return "bridge 环境变量缺失（WA_PI_BRIDGE_URL / WA_PI_BRIDGE_TOKEN / WA_PI_SESSION_ID）：该工具只在 wa-pi 宿主下可用";
	}
	return null;
}

function failResult(text: string, error: string): BridgeToolResult {
	return { content: [{ type: "text", text }], details: { error } };
}

/** 判断错误是否属于可重试的"连接断开"（区别于 token 错误、参数错误等永久失败）。 */
function isRetryableDisconnect(msg: string): boolean {
	return (
		msg.includes("socket connection was closed unexpectedly") ||
		msg.includes("socket hang up")
	);
}

// 经 HTTP 回调 kernel /bridge/tool。任何失败（网络/非 2xx/超时/格式非法）都转成
// 文本结果返回，绝不抛出——避免异常导致 pi 进程崩溃。
async function callBridge(
	tool: string,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	// 默认 60s 空闲兜底：下面 timeout:false 已关掉 Bun 300s 原生硬超时，
	// 若允许省略，未来新增工具忘传时将无任何兜底、永久挂起。传 0 可显式关闭。
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	retryCount: number = 0,
): Promise<BridgeToolResult> {
	const missing = missingEnvError();
	if (missing) return failResult(missing, "missing_env");
	const ctrl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// 空闲超时：每收到一个数据块就重置。只有"长时间无任何帧"才判死——
	// 子代理跑得久但持续有进度帧时不应被掐断。timeoutMs <= 0 为显式关闭。
	const armIdleTimer = () => {
		if (timeoutMs <= 0) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(
			() =>
				ctrl.abort(new Error("bridge 空闲超时 (" + timeoutMs + "ms 无任何帧)")),
			timeoutMs,
		);
	};
	armIdleTimer();
	const onToolAbort = () =>
		ctrl.abort((signal && signal.reason) || new Error("aborted"));
	if (signal) {
		if (signal.aborted) onToolAbort();
		else signal.addEventListener("abort", onToolAbort, { once: true });
	}
	try {
		// timeout:false —— Bun 原生 fetch 有 300s 硬超时（TimeoutError "The operation timed out."，
		// code 23），与 signal 无关、无法被 AbortSignal 延长（Bun 1.3.14 实证 ~300,003ms 触发）。
		// 必须关掉它，否则下面 600s 的空闲超时永远轮不到生效。Bun 专属选项，Node/undici 会忽略。
		const init: RequestInit & { timeout?: boolean } = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: BRIDGE_TOKEN,
				sessionId: BRIDGE_SESSION_ID,
				toolCallId,
				tool,
				params,
			}),
			signal: ctrl.signal,
			timeout: false,
		};
		const res = await fetch(BRIDGE_URL + "/bridge/tool", init);
		// 流式协议：delegate/fleet 返回 NDJSON，逐帧解析 started/progress/ping/final。
		// started/progress/ping 帧仅证明存活（刷新空闲超时），进度已由 kernel SSE 直推前端，
		// 这里只关心 final 帧来组装结果。
		const isStream = (res.headers.get("content-type") ?? "").includes("x-ndjson");
		if (isStream && res.body) {
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = "";
			let finalFrame: any = null;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				armIdleTimer(); // 收到数据块 → 刷新空闲超时（有帧即存活）
				buf += dec.decode(value, { stream: true });
				// 按行切分：最后一行可能不完整（无尾随 \n），留到下一轮拼接
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let frame: any;
					try {
						frame = JSON.parse(line);
					} catch {
						// 单行解析失败：跳过坏帧，不打断流
						continue;
					}
					if (frame.type === "final") {
						finalFrame = frame;
						break;
					}
					// started/progress/ping 帧仅证明存活，不消费
				}
				if (finalFrame) break;
			}
			if (finalFrame) {
				if (finalFrame.ok) {
					return {
						content: finalFrame.result.content,
						details: finalFrame.result.details,
						// 子代理用量（delegate/fleet）：透传给 pi，官方 stats 原生计入累计
						usage: finalFrame.result.usage,
					};
				}
				const err = finalFrame.error ?? "unknown";
				return failResult("bridge 调用失败: " + err, err);
			}
			// 流结束但无 final 帧：连接中断（kernel 侧异常关闭流，可能是偶发断开）
			if (retryCount < MAX_BRIDGE_RETRIES && !signal?.aborted) {
				await new Promise((r) => setTimeout(r, BRIDGE_RETRY_DELAY_MS));
				return callBridge(
					tool,
					toolCallId,
					params,
					signal,
					timeoutMs,
					retryCount + 1,
				);
			}
			return failResult(
				"bridge 调用失败: 连接中断（未收到 final 帧）",
				"stream_interrupted",
			);
		}
		// 降级：非流式响应（老 kernel 或 ask/memory），走旧 JSON 解析
		const data = (await res.json().catch(() => null)) as any;
		if (!res.ok) {
			const errMsg =
				data && typeof data.error === "string" ? data.error : "http_" + res.status;
			return failResult("bridge 调用失败: " + errMsg, errMsg);
		}
		if (!data || !Array.isArray(data.content)) {
			return failResult("bridge 调用失败: 响应格式非法", "invalid_response");
		}
		return { content: data.content, details: data.details };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// 偶发断开（socket 被对端关闭）+ 还有重试次数 + ask 仍有效（signal 未 abort）
		// → 间隔 1 秒后递归重试，让长连接（ask 等用户）在偶发断开后能续上。
		if (
			retryCount < MAX_BRIDGE_RETRIES &&
			isRetryableDisconnect(msg) &&
			!signal?.aborted
		) {
			await new Promise((r) => setTimeout(r, BRIDGE_RETRY_DELAY_MS));
			return callBridge(
				tool,
				toolCallId,
				params,
				signal,
				timeoutMs,
				retryCount + 1,
			);
		}
		return failResult("bridge 调用失败: " + msg, msg);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onToolAbort);
	}
}

// =========================================================================
// 工具注册
// =========================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: ASK_DESCRIPTION,
		promptGuidelines: ASK_PROMPT_GUIDELINES,
		parameters: AskParamsSchema,
		async execute(toolCallId, params, signal) {
			return callBridge(
				"ask_user_question",
				toolCallId,
				params,
				signal,
				ASK_TIMEOUT_MS,
			);
		},
	});

	pi.registerTool({
		name: "memory_add",
		label: "Memory",
		description: MEM_ADD_DESC,
		promptSnippet: MEM_ADD_SNIPPET,
		parameters: Type.Object({
			target: MemoryTargetSchema,
			scope: Type.Optional(MemoryScopeSchema),
			content: Type.String({ description: "The entry content to append." }),
		}),
		async execute(toolCallId, params, signal) {
			return callBridge(
				"memory_add",
				toolCallId,
				params,
				signal,
				DEFAULT_TIMEOUT_MS,
			);
		},
	});

	pi.registerTool({
		name: "memory_replace",
		label: "Memory",
		description: MEM_REPLACE_DESC,
		promptSnippet: MEM_REPLACE_SNIPPET,
		parameters: Type.Object({
			target: MemoryTargetSchema,
			scope: Type.Optional(MemoryScopeSchema),
			oldText: Type.String({
				description: "A short substring uniquely identifying the entry to replace.",
			}),
			newContent: Type.String({
				description: "The replacement entry content.",
			}),
		}),
		async execute(toolCallId, params, signal) {
			return callBridge(
				"memory_replace",
				toolCallId,
				params,
				signal,
				DEFAULT_TIMEOUT_MS,
			);
		},
	});

	pi.registerTool({
		name: "memory_remove",
		label: "Memory",
		description: MEM_REMOVE_DESC,
		promptSnippet: MEM_REMOVE_SNIPPET,
		parameters: Type.Object({
			target: MemoryTargetSchema,
			scope: Type.Optional(MemoryScopeSchema),
			oldText: Type.String({
				description: "A short substring uniquely identifying the entry to remove.",
			}),
		}),
		async execute(toolCallId, params, signal) {
			return callBridge(
				"memory_remove",
				toolCallId,
				params,
				signal,
				DEFAULT_TIMEOUT_MS,
			);
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory",
		description: MEM_READ_DESC,
		promptSnippet: MEM_READ_SNIPPET,
		parameters: Type.Object({
			target: MemoryTargetSchema,
			scope: Type.Optional(MemoryScopeSchema),
		}),
		async execute(toolCallId, params, signal) {
			return callBridge(
				"memory_read",
				toolCallId,
				params,
				signal,
				DEFAULT_TIMEOUT_MS,
			);
		},
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: DELEGATE_DESCRIPTION,
		parameters: DelegateParamsSchema,
		async execute(toolCallId, params, signal) {
			return callBridge(
				"delegate",
				toolCallId,
				params,
				signal,
				DELEGATE_TIMEOUT_MS,
			);
		},
	});

	pi.registerTool({
		name: "fleet",
		label: "Fleet",
		description: FLEET_DESCRIPTION,
		parameters: FleetParamsSchema,
		async execute(toolCallId, params, signal) {
			return callBridge("fleet", toolCallId, params, signal, DELEGATE_TIMEOUT_MS);
		},
	});

	// im_push_to：仅定时任务会话注入（kernel spawn 时设 WA_PI_IM_PUSH_TARGETS，
	// 逗号分隔的联系人 ID 列表；普通会话不设 → 工具不注册，不污染工具面板）。
	// 目标列表在环境变量里（每会话不同），故不能用静态 enum——kernel 侧 handleTool
	// 再校验合法性。execute 经 callBridge 回调 kernel /bridge/tool 分发。
	const IM_PUSH_TARGETS = process.env.WA_PI_IM_PUSH_TARGETS;
	if (IM_PUSH_TARGETS) {
		pi.registerTool({
			name: "im_push_to",
			label: "IM Push",
			description: `推送消息给 IM 联系人。可用联系人：${IM_PUSH_TARGETS}。任务指令中 @im-push-to(渠道,联系人) 标记的联系人即推送目标，任务完成后必须调用本工具推送结果。`,
			parameters: Type.Object({
				contact: Type.String({
					description: "目标联系人 ID（任务指令中 @im-push-to 标记里的 ct_xxx）",
				}),
				message: Type.String({
					description: "要推送的消息内容，支持纯文本和 Markdown",
				}),
			}),
			async execute(toolCallId, params, signal) {
				return callBridge(
					"im_push_to",
					toolCallId,
					params,
					signal,
					DEFAULT_TIMEOUT_MS,
				);
			},
		});
	}

	// 内部热重载触发点：kernel 装卸插件后经 prompt("/__!wa_pi_reload") 触发，
	// 调 ctx.reload() → session.reload()（重读 settings.json packages + 重放 session_start，
	// 让活跃扩展重发 widget/status 恢复 UI）。动态扩展走 pi 官方 packages 机制，
	// reload 重读 packages 让装卸立即生效；内置扩展走 -e（实例属性，reload 保留不失效）。
	// __! 前缀：wa-pi 内部专用命令命名空间，前端命令面板过滤不显示。
	pi.registerCommand("__!wa_pi_reload", {
		description: "wa-pi internal: hot-reload extensions without process restart",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	// ── RPC 模式 TUI 面板降级（custom() 挂根治）──
	//
	// 问题：ctx.ui.custom() 在 RPC 模式原生实现返回 undefined 且不调用 factory 回调。
	// 依赖全屏面板的扩展命令（如 pi-mcp-adapter 的 /mcp → openMcpPanel）在
	// `await new Promise(resolve => ctx.ui.custom(factory))` 中永久挂起——pi 既不回
	// response 也不发事件，wa-pi 无限等待。这是所有用 custom() 的插件共性问题，
	// 非个例。
	//
	// 解法：session_start（bindExtensions 已设好共享 uiContext 之后触发）时，将
	// uiContext.custom() 替换为先 notify 再同步抛出。效果链：
	//   1. ui.notify(msg, "warning") → extension_notify 事件
	//      → 前端聊天窗口中间居中显示，30s 后自动消失（session.ts 已对接）
	//   2. throw → handler throws → _tryExecuteExtensionCommand catch
	//      → extension_error 事件 → 前端 toast 补充提示
	//   3. preflightResult(true) 正常触发 → prompt 成功返回（无挂起）
	//
	// 零超时、零白名单、对所有插件通用。session_start 在每次 bindExtensions
	// （启动 / new_session / switch_session / reload）后都触发，patch 自动重应用。
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		const ui = ctx.ui;
		if (!ui || typeof ui.custom !== "function") return;
		const msg = "此命令需要终端全屏面板（TUI），在当前图形界面模式下不支持";
		// 先 notify（前端 extension_notify 已对接：聊天窗口中间居中显示，30s 自动消失），
		// 再同步 throw 解除 Promise 挂起。throw 带 [custom-unsupported] 标记：
		// 前端 extension_error 处理识别此标记后跳过 toast（notify 已提示，不重复）。
		ui.custom = function custom() {
			ui.notify(msg, "warning");
			throw new Error("[custom-unsupported] " + msg);
		};
	});
}
