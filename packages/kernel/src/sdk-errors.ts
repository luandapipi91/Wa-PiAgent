// 从 SDK 流式事件中提取「运行时错误」文案并分类。
//
// 背景：SDK 契约规定 provider/model/运行时失败**不抛异常**，而是把错误
// 编码进流——以一条 stopReason === "error"（带 errorMessage）的 AssistantMessage
// 收尾，经 message_end 事件透出。因此 ws-server 里包住 session.prompt() 的
// try/catch 永远抓不到这类失败，错误只会以 sdk:event 流到前端。
// 前端又不读 stopReason/errorMessage，导致「选了不可用模型发消息 → 静默无回复」。
//
// 修复：kernel 的 onEvent 在透传 sdk:event 的同时，用本模块检测这类错误事件，
// 若命中则按分类额外广播——
//   - transient（网络/超时/限流等临时错误）→ {type:"net:status"} 状态条提示
//   - fatal（鉴权/配额/模型不可用等确定性错误）→ {type:"error"} 红色会话消息
//
// 只在 message_end 兜口：每条消息（无论成败）都会发一次 message_end，
// 在此兜口可保证「每条失败消息恰好报一次错」，不会因 SDK 的 message_update
// error 变体或内部重试而重复告警。
//
// 分类正则复用 pi-ai dist/utils/retry.js（@earendil-works/pi-ai@0.80.x）的语义。
// 该模块未通过 package.json exports 暴露，无法直接 import，故在此复制精简版，
// 与 pi-ai 保持同步即可。

import type { KernelErrorPayload, SDKEvent } from "@wa-pi/shared";

/**
 * HTTP 状态码 → 通用提示文案枚举。
 * provider 返回整页 HTML 时只取状态码，映射成用户可读的通用提示，
 * 不贴网站页面的 title/HTML（不可读且无信息量）。
 */
const HTTP_STATUS_HINTS: Record<string, { code: string; text: string }> = {
	"400": {
		code: "model.badRequest",
		text: "请求格式错误（400），请检查 Provider 配置",
	},
	"401": {
		code: "model.authFailed",
		text: "鉴权失败（401），请检查 API Key",
	},
	"403": {
		code: "model.forbidden",
		text: "访问被拒绝（403），请检查 API Key 或权限",
	},
	"404": {
		code: "model.notFound",
		text: "接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID",
	},
	"408": { code: "model.timeout", text: "请求超时（408），请稍后重试" },
	"429": {
		code: "model.rateLimited",
		text: "请求过于频繁（429），请稍后重试",
	},
	"500": {
		code: "model.serverError",
		text: "服务端错误（500），请稍后重试",
	},
	"502": { code: "model.badGateway", text: "网关错误（502），请稍后重试" },
	"503": {
		code: "model.serviceUnavailable",
		text: "服务不可用（503），请稍后重试",
	},
	// 504 与 524（Cloudflare 专有）同为网关超时：共用 code，状态码经 params 区分
	"504": {
		code: "model.gatewayTimeout",
		text: "网关超时（504），请稍后重试",
	},
	"524": {
		code: "model.gatewayTimeout",
		text: "网关超时（524），请稍后重试",
	},
};

/**
 * 清洗 errorMessage：provider 返回的错误页（整页 HTML）不可读，
 * 提取 HTTP 状态码映射到预设提示（中文兼容文案 + 结构化 payload）。
 *
 * 例："404 <!DOCTYPE html>..." →
 *   message: "接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID"
 *   payload: { code: "model.notFound", params: { status: "404" }, detail: 原文 }
 *
 * 已知状态码用 HTTP_STATUS_HINTS 精确映射；未枚举的状态码按段位
 * （4xx → model.clientError / 5xx → model.serverError）；
 * HTML 但无法识别状态码 → model.callFailed 兜底。
 * 非 HTML（正常错误文案如 "Connection error."）原样透传，不发 code
 * （payload 为 undefined，前端回落 message，避免字典文案比原文更失真）。
 */
function sanitizeError(raw: string): {
	message: string;
	payload?: KernelErrorPayload;
} {
	// 含 <!DOCTYPE 或 <html 才视为 HTML 错误页，避免误伤含尖括号的正常文案
	if (!/<(?:!DOCTYPE\s+html|html[\s>])/i.test(raw)) return { message: raw };
	// 提取 HTTP 状态码（provider 常把状态码拼在 HTML 前，如 "404 <!DOCTYPE"）
	const statusMatch = raw.match(/\b(\d{3})\b/);
	if (statusMatch) {
		const status = statusMatch[1];
		const hint = HTTP_STATUS_HINTS[status];
		if (hint)
			return {
				message: hint.text,
				payload: { code: hint.code, params: { status }, detail: raw },
			};
		const n = parseInt(status, 10);
		if (n >= 400 && n < 500)
			return {
				message: `请求错误（${status}），请检查请求参数或 Provider 配置`,
				payload: {
					code: "model.clientError",
					params: { status },
					detail: raw,
				},
			};
		if (n >= 500 && n < 600)
			return {
				message: `服务端错误（${status}），请稍后重试`,
				payload: {
					code: "model.serverError",
					params: { status },
					detail: raw,
				},
			};
	}
	// HTML 但无法识别状态码：降级到兜底，不贴整页
	return {
		message: FALLBACK_MESSAGE,
		payload: { code: "model.callFailed", detail: raw },
	};
}

/** errorMessage 缺失时的兜底文案（例如某些 provider 不回具体错误信息） */
const FALLBACK_MESSAGE =
	"模型调用失败，请检查模型与 Provider 配置（模型不可用或鉴权失败）";

/**
 * 临时性（transient）错误正则：网络 / 超时 / 限流 / 5xx 服务端错误。
 * 命中此类 → 走状态条提示，不进对话流。
 *
 * 来源：pi-ai retry.js 的 RETRYABLE_PROVIDER_ERROR_PATTERN（精简）。
 */
const TRANSIENT_ERROR_PATTERN = new RegExp(
	[
		// 通用 provider 负载与 HTTP 临时态
		"overloaded",
		"rate.?limit",
		"too many requests",
		"429",
		// 精确匹配 5xx 状态码：不能用 5\d\d（会误匹配错误页 HTML 里的任意三位数，
		// 如 404 网页里的 "563" 像素宽度）。对齐 pi-ai 0.83.0 retry.js。
		"500",
		"502",
		"503",
		"504",
		"524",
		"service.?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?error",
		"ResourceExhausted",
		// 网络 / 代理 / fetch 传输失败
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"fetch failed",
		"getaddrinfo",
		"ENOTFOUND",
		"ECONNREFUSED",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection",
		"timed.?out",
		"timeout",
		"terminated",
		"websocket.?closed",
		"websocket.?error",
		"ended without",
		"stream ended",
		"http2 request did not get a response",
		// pi-ai 0.84.2 新增：上游请求缓冲失败（pi 内核会自动重试此类错误，属临时性）
		"exceeded request buffer limit",
	].join("|"),
	"i",
);

/**
 * 用户主动中止类错误正则：pi 内部某些异步操作（工具执行 / 模型刷新 / 认证操作等）
 * 被 AbortSignal 中断时，会把 AbortError 当成普通运行时错误，以
 * stopReason:"error" + errorMessage 上报，而非优雅编码为 stopReason:"aborted"。
 *
 * 已知文案（全部是中止语义，应静默而非报错）：
 *   - "The operation was aborted"（pi-ai / pi-coding-agent utils/abort.js abortReason）
 *   - "Operation aborted"（pi-coding-agent 工具层 read/grep/find/edit/write/ls）
 *   - "This operation was aborted"（Node/undici 变体）
 *   - "Request was aborted"（provider 层）
 *   - "Request stream has been aborted"（axios cancel）
 *   - "Command aborted"（bash 工具）
 *   - "The user aborted a request."（Chromium fetch abort）
 *
 * 用户主动停止不是错误：命中此类应返回 null（不广播、不显示），
 * 与 pi 正常编码的 stopReason:"aborted" 走同一静默通道。
 *
 * 匹配策略：aborted 必须在消息尾部（允许尾随标点，或跟 "a request" 宾语）。
 * 刻意排除中间态——如 "model request aborted due to budget limit"（quota 语境，
 * aborted 后有原因从句）必须仍是 fatal，不能被误判为中止静默。
 */
const ABORT_ERROR_PATTERN = /aborted(?:\s+a\s+request)?\s*[.!?]?\s*$/i;

/**
 * 判断纯错误文案是否为「用户主动中止」类错误（abort / cancel）。
 * 供 classifySdkError 静默处理与 session-history 历史回读过滤共用。
 */
function isAbortErrorMessage(message: string): boolean {
	if (!message || !message.trim()) return false;
	return ABORT_ERROR_PATTERN.test(message);
}

/**
 * 确定性（fatal）错误正则：鉴权失败 / 配额耗尽 / 计费类。
 * 命中此类 → 保留红色会话消息（需用户改配置或充值）。
 *
 * 来源：pi-ai retry.js 的 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN + 401/403。
 */
const FATAL_ERROR_PATTERN = new RegExp(
	[
		"insufficient_quota",
		"quota exceeded",
		"out of budget",
		"billing",
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"401", // Unauthorized
		"403", // Forbidden
		"404", // Not Found —— 模型/接口路径不存在（provider baseUrl 错误或模型 ID 无效）
		"unauthorized",
		"forbidden",
		"invalid[_ ]?api[_ ]?key",
		"model[^.]*not.?found", // "Model \"xxx\" not found" —— 模型 ID 不存在
	].join("|"),
	"i",
);

export type ErrorCategory = "transient" | "fatal";

export interface ClassifiedError {
	category: ErrorCategory;
	/** 中文兼容文案：保留供未迁移的老渲染路径兑底（前端新路径优先按 failure.code 查字典） */
	message: string;
	/** 结构化失败载荷（见 sanitizeError / 映射表）；非 HTML 原文透传时缺省 */
	failure?: KernelErrorPayload;
}

/**
 * 从 SDK 事件中提取运行时错误文案。
 * @returns 错误文案（有 errorMessage 用之，否则兜底）；非错误事件返回 null。
 * @deprecated 保留向后兼容；新代码请用 classifySdkError（带分类）。
 */
export function extractSdkErrorMessage(event: SDKEvent): string | null {
	// message_end 之外的类型一律不处理（message_start/update 等会被 message_end 覆盖）
	if (event.type !== "message_end") return null;

	// AgentMessage 是联合类型（含无 role 的 CustomMessage），统一 as any 读字段，
	// 与 store/session.ts 等处保持一致的桥接写法。
	const msg = (event as any).message;
	if (msg?.role !== "assistant" || msg?.stopReason !== "error") return null;

	const detail =
		typeof msg.errorMessage === "string" && msg.errorMessage.trim().length > 0
			? msg.errorMessage.trim()
			: null;
	// 用户主动停止（abort/cancel）不是错误：不提取文案，保持与 stopReason:"aborted" 一致静默。
	if (detail && isAbortErrorMessage(detail)) return null;
	return detail ? sanitizeError(detail).message : FALLBACK_MESSAGE;
}

/**
 * 从 SDK 事件中提取运行时错误并分类（transient / fatal）。
 *
 * 分类优先级：先 fatal（配额/鉴权/模型不可用），再 transient（网络/5xx/限流），
 * 都不命中默认 fatal（保守，保留可见的红色提示，避免静默）。
 *
 * @returns 分类错误对象；非错误事件返回 null。
 */
export function classifySdkError(event: SDKEvent): ClassifiedError | null {
	// message_end 之外的类型一律不处理
	if (event.type !== "message_end") return null;

	const msg = (event as any).message;
	if (msg?.role !== "assistant" || msg?.stopReason !== "error") return null;

	const detail =
		typeof msg.errorMessage === "string" && msg.errorMessage.trim().length > 0
			? msg.errorMessage.trim()
			: null;
	// 用户主动停止（abort/cancel）不是错误：不广播、不显示，
	// 与 pi 正常编码的 stopReason:"aborted" 走同一静默通道。
	// 注意：必须在分类之前判断——abort 类既不是 transient 也不是 fatal，
	// 直接命中默认 fatal 会误报红色错误（即此前用户停止时看到的
	// "The operation was aborted." 提示的根因）。
	if (detail && isAbortErrorMessage(detail)) return null;

	// 展示文案需清洗（HTML 错误页不可读）；分类正则仍用原始 detail（保留完整信息供匹配）。
	// sanitizeError 同时产出中文兼容文案与结构化 payload（code/params/detail，见映射表）。
	const sanitized = detail
		? sanitizeError(detail)
		: {
				message: FALLBACK_MESSAGE,
				payload: { code: "model.callFailed" } as KernelErrorPayload,
			};
	const message = sanitized.message;

	// 无具体文案时无法判别，保守归 fatal
	const category: ErrorCategory = detail
		? FATAL_ERROR_PATTERN.test(detail)
			? "fatal"
			: TRANSIENT_ERROR_PATTERN.test(detail)
				? "transient"
				: "fatal"
		: "fatal";

	return { category, message, failure: sanitized.payload };
}

/**
 * 判断纯错误文案是否为 transient（网络类临时错误）。
 * 供 session-history 历史回读过滤使用（只有文案字符串，无完整事件）。
 */
export function isTransientErrorMessage(message: string): boolean {
	if (!message || !message.trim()) return false;
	// abort 类（用户主动停止残留）：同样不应留在历史里，刷新后不该重新出现
	if (isAbortErrorMessage(message)) return true;
	// transient 判定前先排除 fatal，避免 "connection error" 误吞带配额语境的文案
	if (FATAL_ERROR_PATTERN.test(message)) return false;
	return TRANSIENT_ERROR_PATTERN.test(message);
}
