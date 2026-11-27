import { test, expect } from "bun:test";
import type { SDKEvent } from "@wa-pi/shared";
import {
	extractSdkErrorMessage,
	classifySdkError,
	isTransientErrorMessage,
	FATAL_ERROR_PATTERN,
} from "../src/sdk-errors";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

// 根因回归：SDK 把 provider 运行时错误（不可用模型 / 鉴权失败 / 网络）
// 编码成 message_end{stopReason:"error", errorMessage} 事件而非抛异常。
// 该助手函数负责从中提取可展示的错误文案，供 kernel 翻译成 {type:"error"} 广播。

test("message_end 带 stopReason:error + errorMessage → 返回 errorMessage", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			model: "slug/231223",
			stopReason: "error",
			errorMessage: 'Model "231223" not found',
			timestamp: 1,
		} as any,
	};
	expect(extractSdkErrorMessage(event)).toBe('Model "231223" not found');
});

test("message_end 带 stopReason:error 但无 errorMessage → 返回兜底文案", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			model: "slug/231223",
			stopReason: "error",
			timestamp: 1,
		} as any,
	};
	const msg = extractSdkErrorMessage(event);
	expect(msg).not.toBeNull();
	expect(typeof msg).toBe("string");
	expect(msg!.length).toBeGreaterThan(0);
});

test("正常结束 stopReason:stop → null（不误报）", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "m",
			stopReason: "stop",
			timestamp: 1,
		} as any,
	};
	expect(extractSdkErrorMessage(event)).toBeNull();
});

test("user 角色的 message_end → null", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: { role: "user", content: "hi", timestamp: 1 } as any,
	};
	expect(extractSdkErrorMessage(event)).toBeNull();
});

test("非 message_end 事件 → null", () => {
	const agentStart: SDKEvent = { type: "agent_start" };
	const agentEnd: SDKEvent = {
		type: "agent_end",
		messages: [],
		willRetry: false,
	};
	expect(extractSdkErrorMessage(agentStart)).toBeNull();
	expect(extractSdkErrorMessage(agentEnd)).toBeNull();
});

test("message_start 首帧（即便 stopReason 占位）→ null", () => {
	const event: SDKEvent = {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			stopReason: "stop",
			timestamp: 1,
		} as any,
	};
	expect(extractSdkErrorMessage(event)).toBeNull();
});

// ========== 错误分类（transient / fatal）==========
//
// 背景：网络类错误（Connection error / timeout / fetch failed）是临时性的，
// 适合用状态条提示而非红色会话消息。鉴权失败 / 配额耗尽 / 模型不可用是确定性错误，
// 需保留红色消息提示用户改配置。classifySdkError 负责按文案分类。
// 正则来源：复用 pi-ai dist/utils/retry.js 的语义（该模块未通过 exports 暴露，无法直接 import）。

function errEvent(errorMessage: string): SDKEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			stopReason: "error",
			errorMessage,
			timestamp: 1,
		} as any,
	};
}

test("classifySdkError: Connection error. → transient（网络临时错误）", () => {
	expect(classifySdkError(errEvent("Connection error."))?.category).toBe(
		"transient",
	);
});

test("classifySdkError: Request timed out. → transient", () => {
	expect(classifySdkError(errEvent("Request timed out."))?.category).toBe(
		"transient",
	);
});

test("classifySdkError: fetch failed → transient", () => {
	expect(classifySdkError(errEvent("fetch failed"))?.category).toBe("transient");
});

test("classifySdkError: socket hang up → transient", () => {
	expect(classifySdkError(errEvent("socket hang up"))?.category).toBe(
		"transient",
	);
});

test("classifySdkError: 503 Service Unavailable → transient（5xx 服务端错误）", () => {
	expect(classifySdkError(errEvent("503 Service Unavailable"))?.category).toBe(
		"transient",
	);
});

test("classifySdkError: rate limit exceeded → transient（限流）", () => {
	expect(classifySdkError(errEvent("rate limit exceeded"))?.category).toBe(
		"transient",
	);
});

test("classifySdkError: insufficient_quota → fatal（配额耗尽，需用户处理）", () => {
	expect(classifySdkError(errEvent("insufficient_quota"))?.category).toBe(
		"fatal",
	);
});

test("classifySdkError: 401 Unauthorized → fatal（鉴权失败）", () => {
	expect(classifySdkError(errEvent("401 Unauthorized"))?.category).toBe("fatal");
});

test("classifySdkError: 403 Forbidden → fatal（鉴权失败）", () => {
	expect(classifySdkError(errEvent("403 Forbidden"))?.category).toBe("fatal");
});

test("classifySdkError: Model not found → fatal（模型不可用）", () => {
	expect(classifySdkError(errEvent('Model "foo" not found'))?.category).toBe(
		"fatal",
	);
});

// 回归：404 错误页（HTML）不得误分类为 transient。
// 根因：错误页 HTML 含任意三位数（如像素宽度 "563"），旧的宽泛正则 5\d\d
// 会误匹配 → 错误归类成 transient，导致确定性失败被当成"网络重试"，
// 既显示误导文案（模型连接异常/检查网络）又卡在 loading 不结束。
test("classifySdkError: 404 HTML 错误页 → fatal（不得误分类 transient）", () => {
	// 真实抓取的 opencode-go provider 404 响应（含 width="563" 等三位数）
	const html404 =
		'404 <!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8">' +
		'<div width="563" style="height:563px"><span id="err-563">server error</span></div></html>';
	expect(classifySdkError(errEvent(html404))?.category).toBe("fatal");
});

test("classifySdkError: 明文 500 → transient（真实 5xx 仍应识别）", () => {
	expect(
		classifySdkError(errEvent("HTTP 500 Internal Server Error"))?.category,
	).toBe("transient");
});

test("classifySdkError: 未知错误文案 → fatal（保守，保留红色提示）", () => {
	expect(classifySdkError(errEvent("某种未知的奇怪错误"))?.category).toBe(
		"fatal",
	);
});

test("classifySdkError: 正常结束 stopReason:stop → null", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "m",
			stopReason: "stop",
			timestamp: 1,
		} as any,
	};
	expect(classifySdkError(event)).toBeNull();
});

test("classifySdkError: 无 errorMessage 的错误 → fatal + 兜底文案", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			stopReason: "error",
			timestamp: 1,
		} as any,
	};
	const result = classifySdkError(event);
	expect(result?.category).toBe("fatal");
	expect(result?.message.length).toBeGreaterThan(0);
});

// isTransientErrorMessage：供 session-history 历史回读过滤使用（只传文案字符串）

// ========== 用户主动中止（abort）类错误 ==========
//
// 背景：用户点击「停止」时，pi 内部某些异步操作（工具执行 / 模型刷新 / 认证操作等）
// 被 AbortSignal 中断，会把 AbortError 当成普通运行时错误上报，
// 即 stopReason:"error" + errorMessage:"The operation was aborted"。
// 用户主动停止不是错误：应静默（返回 null），与 stopReason:"aborted" 一致，
// 不得弹红色错误提示。此前缺此判断，abort 类文案不匹配 transient/fatal 正则 →
// 默认归 fatal → 广播 {type:"error"} → 前端显示红色错误消息（误报）。

function abortErrEvent(errorMessage: string): SDKEvent {
	return errEvent(errorMessage);
}

test("classifySdkError: The operation was aborted → null（用户停止不报错）", () => {
	expect(
		classifySdkError(abortErrEvent("The operation was aborted")),
	).toBeNull();
});

test("classifySdkError: This operation was aborted → null（Node/undici 变体）", () => {
	expect(
		classifySdkError(abortErrEvent("This operation was aborted")),
	).toBeNull();
});

test("classifySdkError: Operation aborted → null（工具层变体）", () => {
	expect(classifySdkError(abortErrEvent("Operation aborted"))).toBeNull();
});

test("classifySdkError: Request was aborted → null（provider 层变体）", () => {
	expect(classifySdkError(abortErrEvent("Request was aborted"))).toBeNull();
});

test("classifySdkError: Request stream has been aborted → null（axios cancel 变体）", () => {
	expect(
		classifySdkError(abortErrEvent("Request stream has been aborted")),
	).toBeNull();
});

test("classifySdkError: The user aborted a request. → null（Chromium fetch abort 变体）", () => {
	expect(
		classifySdkError(abortErrEvent("The user aborted a request.")),
	).toBeNull();
});

test("classifySdkError: Command aborted → null（bash 工具变体）", () => {
	expect(classifySdkError(abortErrEvent("Command aborted"))).toBeNull();
});

test("extractSdkErrorMessage: The operation was aborted → null", () => {
	expect(
		extractSdkErrorMessage(abortErrEvent("The operation was aborted")),
	).toBeNull();
});

test("isTransientErrorMessage: The operation was aborted → true（历史回读应过滤）", () => {
	expect(isTransientErrorMessage("The operation was aborted")).toBe(true);
});

test("isTransientErrorMessage: Operation aborted → true", () => {
	expect(isTransientErrorMessage("Operation aborted")).toBe(true);
});

test("isTransientErrorMessage: 含 abort 的上下文文案 → true（仍属中止语义）", () => {
	expect(isTransientErrorMessage("AbortError: The operation was aborted.")).toBe(
		true,
	);
});

// 回归：abort 判断不得误伤真正 fatal / transient 文案

test("classifySdkError: 含 aborted 的 quota 文案 → 仍是 fatal（不误伤）", () => {
	const event = errEvent(
		"quota exceeded: model request aborted due to budget limit",
	);
	expect(classifySdkError(event)?.category).toBe("fatal");
});

test("classifySdkError: Connection error. → 仍是 transient（abort 判断不改变现有分类）", () => {
	expect(classifySdkError(errEvent("Connection error."))?.category).toBe(
		"transient",
	);
});

test("classifySdkError: insufficient_quota → 仍是 fatal", () => {
	expect(classifySdkError(errEvent("insufficient_quota"))?.category).toBe(
		"fatal",
	);
});

// ========== HTML 错误页清洗 ==========
//
// 背景：provider baseUrl 错误时返回整页 HTML（如 404 网站页面），
// 原样贴到会话流不可读（数千字符）。sanitizeErrorMessage 提取
// HTTP 状态码映射到预设的通用提示文案。

test("classifySdkError: 404 HTML 错误页 message 映射到通用提示", () => {
	const html =
		'404 <!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
		'<title data-sm="x">Not Found | opencode</title></head><body><div width="563">server error</div></body></html>';
	const result = classifySdkError(errEvent(html));
	expect(result?.category).toBe("fatal");
	// 清洗后映射到预设枚举，不含 HTML 标签
	expect(result?.message).toBe(
		"接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID",
	);
	expect(result?.message).not.toContain("<");
	expect(result!.message.length).toBeLessThan(html.length);
});

test("classifySdkError: 503 HTML 错误页映射到通用提示", () => {
	const html = "503 <!DOCTYPE html><html><body>maintenance</body></html>";
	expect(classifySdkError(errEvent(html))?.message).toBe(
		"服务不可用（503），请稍后重试",
	);
});

test("classifySdkError: 401 HTML 错误页映射到鉴权提示", () => {
	const html = "401 <!DOCTYPE html><html><body>unauthorized</body></html>";
	expect(classifySdkError(errEvent(html))?.message).toBe(
		"鉴权失败（401），请检查 API Key",
	);
});

test("classifySdkError: 正常错误文案（非 HTML）原样保留", () => {
	expect(classifySdkError(errEvent("Connection error."))?.message).toBe(
		"Connection error.",
	);
	expect(classifySdkError(errEvent('Model "foo" not found'))?.message).toBe(
		'Model "foo" not found',
	);
});

test("classifySdkError: HTML 但无法识别状态码 → 兜底文案", () => {
	// HTML 中无可识别的三位数状态码
	const html = "<!DOCTYPE html><html><body>weird error</body></html>";
	const result = classifySdkError(errEvent(html));
	expect(result?.message).toBe(
		"模型调用失败，请检查模型与 Provider 配置（模型不可用或鉴权失败）",
	);
});

// 未枚举的 HTTP 状态码按段位给通用提示（带上具体状态码供排查）
test("classifySdkError: 未枚举 4xx（422）→ 请求错误通用提示", () => {
	const html =
		"422 <!DOCTYPE html><html><body>Unprocessable Entity</body></html>";
	expect(classifySdkError(errEvent(html))?.message).toBe(
		"请求错误（422），请检查请求参数或 Provider 配置",
	);
});

test("classifySdkError: 未枚举 5xx（507）→ 服务端错误通用提示", () => {
	const html =
		"507 <!DOCTYPE html><html><body>Insufficient Storage</body></html>";
	expect(classifySdkError(errEvent(html))?.message).toBe(
		"服务端错误（507），请稍后重试",
	);
});

test("classifySdkError: 451 Legal Redirect → 4xx 通用提示", () => {
	const html =
		"451 <!DOCTYPE html><html><body>Unavailable For Legal Reasons</body></html>";
	expect(classifySdkError(errEvent(html))?.message).toBe(
		"请求错误（451），请检查请求参数或 Provider 配置",
	);
});

test("extractSdkErrorMessage: 404 HTML 映射到通用提示", () => {
	const html =
		"404 <!DOCTYPE html><html><head><title>Not Found</title></head></html>";
	expect(extractSdkErrorMessage(errEvent(html))).toBe(
		"接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID",
	);
});

test("isTransientErrorMessage: Connection error. → true", () => {
	expect(isTransientErrorMessage("Connection error.")).toBe(true);
});

test("isTransientErrorMessage: insufficient_quota → false", () => {
	expect(isTransientErrorMessage("insufficient_quota")).toBe(false);
});

test("isTransientErrorMessage: 空字符串 → false", () => {
	expect(isTransientErrorMessage("")).toBe(false);
});

// ========== 结构化 failure（KernelErrorPayload）==========
//
// message（中文兼容文案）保留；新增 failure 按映射表给出稳定 code + params，
// 前端按 code 查 kernelMsg 字典渲染（i18n），detail 携带原始错误信息供排查。
// 映射表见 sdk-errors.ts HTTP_STATUS_HINTS（14 条，格式 model.<语义>）。

test("classifySdkError: 404 HTML 错误页 → failure=model.notFound + status params", () => {
	const html = "404 <!DOCTYPE html><html><body>Not Found</body></html>";
	const result = classifySdkError(errEvent(html));
	expect(result?.failure).toEqual({
		code: "model.notFound",
		params: { status: "404" },
		detail: html,
	});
});

test("classifySdkError: 401 HTML → model.authFailed", () => {
	const html = "401 <!DOCTYPE html><html><body>unauthorized</body></html>";
	expect(classifySdkError(errEvent(html))?.failure?.code).toBe(
		"model.authFailed",
	);
});

test("classifySdkError: 429 HTML → model.rateLimited", () => {
	const html = "429 <!DOCTYPE html><html><body>too many requests</body></html>";
	expect(classifySdkError(errEvent(html))?.failure?.code).toBe(
		"model.rateLimited",
	);
});

test("classifySdkError: 未枚举 422 HTML → model.clientError", () => {
	const html =
		"422 <!DOCTYPE html><html><body>Unprocessable Entity</body></html>";
	const f = classifySdkError(errEvent(html))?.failure;
	expect(f?.code).toBe("model.clientError");
	expect(f?.params).toEqual({ status: "422" });
});

test("classifySdkError: 未枚举 507 HTML → model.serverError", () => {
	const html =
		"507 <!DOCTYPE html><html><body>Insufficient Storage</body></html>";
	const f = classifySdkError(errEvent(html))?.failure;
	expect(f?.code).toBe("model.serverError");
	expect(f?.params).toEqual({ status: "507" });
});

test("classifySdkError: HTML 无状态码 → model.callFailed（detail 保留原文）", () => {
	const html = "<!DOCTYPE html><html><body>weird error</body></html>";
	const f = classifySdkError(errEvent(html))?.failure;
	expect(f?.code).toBe("model.callFailed");
	expect(f?.detail).toBe(html);
});

test("classifySdkError: 无 errorMessage → failure=model.callFailed（无 detail）", () => {
	const event: SDKEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			stopReason: "error",
			timestamp: 1,
		} as any,
	};
	expect(classifySdkError(event)?.failure).toEqual({
		code: "model.callFailed",
	});
});

test("classifySdkError: 非 HTML 原文（Connection error.）→ failure 缺省（原文透传）", () => {
	expect(
		classifySdkError(errEvent("Connection error."))?.failure,
	).toBeUndefined();
});

// ── pi 1.4.0 retry.js 同步（1.4.0 扩大了自动重试覆盖面）──
// 口径：这些文案自 pi 1.4.0 起由引擎自动重试（1.3.0 不重试）。
// 分类副本不同步 → 重试期间被当成致命错误弹红，或重试耗尽后的临时错误
// 被当成正式回复留在历史里。

test("pi 1.4.0 新增 transient：stream disconnected before completion", () => {
	expect(
		isTransientErrorMessage(
			"stream disconnected before completion: stream closed before response.completed",
		),
	).toBe(true);
});

test("pi 1.4.0 新增 transient：上游失败文案四种", () => {
	expect(isTransientErrorMessage("upstream request failed")).toBe(true);
	expect(isTransientErrorMessage("upstream_stream_read_error")).toBe(true);
	expect(isTransientErrorMessage("stream was interrupted")).toBe(true);
	expect(isTransientErrorMessage("http/2 stream failed")).toBe(true);
});

test("pi 1.4.0 新增 transient：OAuth 刷新失败（request to … failed, reason:）", () => {
	expect(
		isTransientErrorMessage(
			"request to https://oauth2.googleapis.com/token failed, reason:",
		),
	).toBe(true);
});

test("pi 1.4.0：状态码按词边界匹配——请求 id 里的 429/500 不再误判 transient", () => {
	expect(
		isTransientErrorMessage("request id chatcmpl-500x429y was rejected"),
	).toBe(false);
});

test("pi 1.4.0：独立的 HTTP 500 仍判 transient（边界匹配不放松真实状态码）", () => {
	expect(isTransientErrorMessage("gateway returned 500")).toBe(true);
});

test("pi 1.4.0 新增 transient 文案经 classifySdkError 分类为 transient", () => {
	expect(
		classifySdkError(
			errEvent(
				"stream disconnected before completion: stream closed before response.completed",
			),
		)?.category,
	).toBe("transient");
});

test("pi 1.5.0：智谱/Z.ai 套餐限额（HTTP 429 携带 code 1308）→ fatal，不再无效重试", () => {
	const body = 'HTTP 429 {"error":{"code":1308,"message":"usage limit reached"}}';
	// 1308 条目在 FATAL 表（优先判定），不再被 TRANSIENT 的 429 词边界拖去无效重试
	expect(classifySdkError(errEvent(body))?.category).toBe("fatal");
});

test("pi 1.5.0：1308 正则负向前瞻——13080/11308 等长数字不被 1308 条目命中", () => {
	// 兜底语义下"非 fatal"测不出条目精确性，直接断言正则本身
	expect(FATAL_ERROR_PATTERN.test('{"code":13080}')).toBe(false);
	expect(FATAL_ERROR_PATTERN.test('{"code":11308,"message":"x"}')).toBe(false);
	expect(FATAL_ERROR_PATTERN.test('"code": 1308')).toBe(true);
});

test("pi 1.4.0 遗漏补齐：个人版用量上限条目进入 FATAL 表（不再依赖兜底）", () => {
	expect(FATAL_ERROR_PATTERN.test("subscription_sharing_usage_limit_exceeded")).toBe(true);
});

// ===== pi-ai 1.6.0 的 retry.js 新增条目（#12064 / #12128 / #12124）=====
// 上游把这几类从「不重试」改成「自动重试」，kernel 的状态条分类要跟着走：
// 否则 pi 侧已经重试过的临时失败，前端只会弹一条红色错误。

test("pi 1.6.0 新增 transient：网关中途断连报 Connection closed.", () => {
	expect(classifySdkError(errEvent("Connection closed."))?.category).toBe("transient");
});

test("pi 1.6.0 新增 transient：裸 Node socket 错误码", () => {
	for (const text of [
		"read ECONNRESET",
		"write EPIPE",
		"connect ETIMEDOUT 1.2.3.4:443",
		"read ECONNABORTED",
	]) {
		expect(classifySdkError(errEvent(text))?.category).toBe("transient");
	}
});

test("pi 1.6.0 新增 transient：connection reset by peer", () => {
	expect(
		classifySdkError(errEvent("read error: connection reset by peer"))?.category,
	).toBe("transient");
});

test("pi 1.6.0 新增 transient：Codex WebSocket 60 分钟连接上限", () => {
	for (const text of [
		"websocket_connection_limit_reached",
		"Responses websocket connection limit reached",
	]) {
		expect(classifySdkError(errEvent(text))?.category).toBe("transient");
	}
});

test("pi 1.6.0：socket 错误码的边界断言有效（更长的标识符不被命中）", () => {
	// 这两个字符串里的 ECONNRESET / EPIPE 属于更长的标识符/单词，
	// 若正则不限定标识符边界，真实致命错误会被误判成临时网络错误而只弹状态条。
	expect(
		classifySdkError(errEvent("gateway rejected field MY_ECONNRESET_CODE"))?.category,
	).toBe("fatal");
	expect(classifySdkError(errEvent("unknown flag RECIPE_MODE"))?.category).toBe("fatal");
});

test("pi 1.6.0：裸 socket 错误码 ECONNABORTED 不被「用户中止」正则误吞", () => {
	// 回归：ECONNABORTED 以 "ABORTED" 结尾，旧的中止正则（aborted 在尾部即命中）
	// 会把这条网络失败判成「用户主动停止」而静默丢弃——pi 侧已在重试，
	// 前端却连状态条都不弹。中止正则必须要求 aborted 是独立单词。
	expect(classifySdkError(errEvent("read ECONNABORTED"))?.category).toBe("transient");
	// 真正的中止文案仍要静默
	expect(classifySdkError(abortErrEvent("Operation aborted"))).toBeNull();
	expect(classifySdkError(abortErrEvent("The operation was aborted."))).toBeNull();
});

// ===== pi-ai 1.6.1 的 retry.js 新增条目 =====
// 上游把下面这些从「不重试」改成「自动重试」（1.6.1 changelog 的 Fixed 段）：
// Cloudflare 525、网关「provider is temporarily unavailable」、Anthropic 流内 api_error、
// OpenRouter 空响应 / 无输出即停、finish_reason:"error"、排队超过准入上限、
// 「request rate increased too quickly」节流、以及若干网关中途失败文案。
// kernel 的状态条分类必须同步：否则 pi 已经在重试的临时失败，重试耗尽后
// 会在前端弹一条红色错误消息，而不是走状态条。

test("pi 1.6.1 新增 transient：Cloudflare 525（TLS 握手失败）", () => {
	expect(classifySdkError(errEvent("Cloudflare returned 525"))?.category).toBe(
		"transient",
	);
});

test("pi 1.6.1：状态码 525 不属于更长数字（词边界仍生效）", () => {
	// 与既有的 429/500 边界断言同款：请求 id / 字节数里的数字不得被当成状态码
	expect(classifySdkError(errEvent("req_525abc failed"))?.category).toBe("fatal");
	expect(classifySdkError(errEvent("size 15251 bytes"))?.category).toBe("fatal");
});

test("pi 1.6.1 新增 transient：网关 provider is temporarily unavailable", () => {
	expect(
		classifySdkError(
			errEvent("The provider is temporarily unavailable. Retry shortly."),
		)?.category,
	).toBe("transient");
});

test("pi 1.6.1：裸 provider unavailable（无 temporarily）仍是 fatal——是持续性路由错误", () => {
	expect(classifySdkError(errEvent("provider unavailable"))?.category).toBe("fatal");
});

test("pi 1.6.1 新增 transient：Anthropic 流内 api_error 事件", () => {
	// 流已开始后 Anthropic 用无状态码的 error 事件报内部失败
	const body =
		'{"type":"error","error":{"type":"api_error","message":"Unable to complete this request right now."}}';
	expect(classifySdkError(errEvent(body))?.category).toBe("transient");
});

test("pi 1.6.1 新增 transient：invalid_request_error 不因 api_error 条目被误伤", () => {
	// 只有 type == api_error 才是临时内部错误；请求格式错误必须仍走 fatal
	const body =
		'{"type":"error","error":{"type":"invalid_request_error","message":"messages: bad field"}}';
	expect(classifySdkError(errEvent(body))?.category).toBe("fatal");
});

test("pi 1.6.1 新增 transient：OpenAI 兼容流以 finish_reason: error 收尾", () => {
	for (const text of [
		"Provider finish_reason: error",
		"provider finish_reason: error",
	]) {
		expect(classifySdkError(errEvent(text))?.category).toBe("transient");
	}
});

test("pi 1.6.1 新增 transient：Mistral provider stopped with: error", () => {
	expect(
		classifySdkError(errEvent("Provider stopped with: error"))?.category,
	).toBe("transient");
});

test("pi 1.6.1 新增 transient：OpenRouter 空响应与未完成即停", () => {
	for (const text of [
		"Provider returned an empty response",
		"Upstream error from Relace: The model stopped before completing the response.",
	]) {
		expect(classifySdkError(errEvent(text))?.category).toBe("transient");
	}
});

test("pi 1.6.1 新增 transient：网关 SSE error 帧说响应未完成", () => {
	expect(
		classifySdkError(errEvent("The provider ended the response before it was complete."))
			?.category,
	).toBe("transient");
});

test("pi 1.6.1 新增 transient：连接被上游重置与「生成时上报失败」文案", () => {
	for (const text of [
		"connection to the provider was reset",
		"The provider reported a failure while generating the response",
	]) {
		expect(classifySdkError(errEvent(text))?.category).toBe("transient");
	}
});

test("pi 1.6.1 新增 transient：排队超过准入上限（admission ceiling）", () => {
	expect(
		classifySdkError(
			errEvent(
				"waited 73.4s in queue, reaching this model's admission ceiling of 60s",
			),
		)?.category,
	).toBe("transient");
});

test("pi 1.6.1 新增 transient：OpenAI slow_down / Qwen 节流文案", () => {
	expect(
		classifySdkError(errEvent("Request rate increased too quickly"))?.category,
	).toBe("transient");
});

test("pi 1.6.1 新增 transient：显式重试指引 repeat the request later", () => {
	expect(
		classifySdkError(errEvent("Unable to process request. Repeat the request later."))
			?.category,
	).toBe("transient");
});

test("pi 1.6.1 新增 transient：网关「对端已关闭」与上游要求退避", () => {
	expect(classifySdkError(errEvent("other side closed"))?.category).toBe(
		"transient",
	);
	// 上游给出的 retry delay 上限失败，交给外层重试策略处理
	expect(
		classifySdkError(errEvent("retry delay exceeded the provider limit"))
			?.category,
	).toBe("transient");
});

test("pi 1.6.1：kernel 的 transient 判定必须覆盖 pi-ai 的 auto-retry 判定（探针式契约）", () => {
	// 不变量：pi 会自动重试的失败，kernel 必须判 transient（弹状态条而非红色错误）；
	// 反过来不要求相等——kernel 多判几条 transient 无害（pi 不重试但我们仍按临时错误提示）。
	// 这里直接调 pi-ai 自己的判定函数做对照，而不是抄一份文案清单：
	// 升级 pi 后若上游新增文案而 kernel 没跟上，这个用例会红。
	const samples = [
		"overloaded",
		"server_busy",
		"servers are currently busy",
		"currently experiencing high demand",
		"model is at capacity",
		"admission ceiling",
		"rate limit",
		"too many requests",
		"rate increased too quickly",
		"gateway returned 500",
		"Cloudflare returned 525",
		"The service is temporarily unavailable",
		"The provider is temporarily unavailable. Retry shortly.",
		"server error",
		"internal error",
		"Provider returned an error",
		'{"type":"error","error":{"type":"api_error","message":"Unable to complete"}}',
		"exceeded request buffer limit while retrying upstream",
		"unable to forward upstream",
		"upstream request failed",
		"upstream_stream_read_error",
		"stream was interrupted",
		"http2 stream failed",
		"network error",
		"connection error",
		"connection refused",
		"connection lost",
		"Connection closed.",
		"other side closed",
		"fetch failed",
		"request to https://x failed, reason: empty",
		"getaddrinfo ENOTFOUND",
		"read ECONNRESET",
		"connection reset by peer",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed out",
		"timeout",
		"terminated",
		"websocket closed",
		"websocket error",
		"websocket_connection_limit_reached",
		"stream ended without message_stop",
		"http2 request did not get a response",
		"Provider finish_reason: error",
		"Provider stopped with: error",
		"Provider returned an empty response",
		"The model stopped before completing the response.",
		"stream disconnected before completion",
		"Claude Code's stream from Anthropic was cut short after the reply had begun",
		"The provider ended the response before it was complete.",
		"connection to the provider was reset",
		"The provider reported a failure while generating the response",
		"pending stream has been canceled",
		"retry delay exceeded the provider limit",
		"you can retry your request",
		"try your request again",
		"please retry your request",
		"Repeat the request later.",
		"ResourceExhausted",
		"subscription_sharing_usage_unavailable",
		"subscription_sharing_user_unavailable",
	];
	const drifted = samples.filter((text) => {
		const piRetries = isRetryableAssistantError({
			stopReason: "error",
			errorMessage: text,
		} as any);
		if (!piRetries) return true; // 样本本身失效：pi 已不再重试这条，需要人工复核样本
		return classifySdkError(errEvent(text))?.category !== "transient";
	});
	expect(drifted).toEqual([]);
});
