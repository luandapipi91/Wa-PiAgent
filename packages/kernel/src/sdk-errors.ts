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

import type { SDKEvent } from "@wa-pi/shared";

/** errorMessage 缺失时的兜底文案（例如某些 provider 不回具体错误信息） */
const FALLBACK_MESSAGE = "模型调用失败，请检查模型与 Provider 配置（模型不可用或鉴权失败）";

/**
 * 临时性（transient）错误正则：网络 / 超时 / 限流 / 5xx 服务端错误。
 * 命中此类 → 走状态条提示，不进对话流。
 *
 * 来源：pi-ai retry.js 的 RETRYABLE_PROVIDER_ERROR_PATTERN（精简）。
 */
const TRANSIENT_ERROR_PATTERN = new RegExp([
  // 通用 provider 负载与 HTTP 临时态
  "overloaded",
  "rate.?limit",
  "too many requests",
  "429",
  "5\\d\\d", // 覆盖 500/502/503/504/524
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
].join("|"), "i");

/**
 * 确定性（fatal）错误正则：鉴权失败 / 配额耗尽 / 计费类。
 * 命中此类 → 保留红色会话消息（需用户改配置或充值）。
 *
 * 来源：pi-ai retry.js 的 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN + 401/403。
 */
const FATAL_ERROR_PATTERN = new RegExp([
  "insufficient_quota",
  "quota exceeded",
  "out of budget",
  "billing",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  "40[13]", // 401 Unauthorized / 403 Forbidden
  "unauthorized",
  "forbidden",
  "invalid[_ ]?api[_ ]?key",
  "model[^.]*not.?found", // "Model \"xxx\" not found" —— 模型 ID 不存在
].join("|"), "i");

export type ErrorCategory = "transient" | "fatal";

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
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
  return detail ?? FALLBACK_MESSAGE;
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
  const message = detail ?? FALLBACK_MESSAGE;

  // 无具体文案时无法判别，保守归 fatal
  const category: ErrorCategory = !detail
    ? "fatal"
    : FATAL_ERROR_PATTERN.test(detail)
      ? "fatal"
      : TRANSIENT_ERROR_PATTERN.test(detail)
        ? "transient"
        : "fatal";

  return { category, message };
}

/**
 * 判断纯错误文案是否为 transient（网络类临时错误）。
 * 供 session-history 历史回读过滤使用（只有文案字符串，无完整事件）。
 */
export function isTransientErrorMessage(message: string): boolean {
  if (!message || !message.trim()) return false;
  // transient 判定前先排除 fatal，避免 "connection error" 误吞带配额语境的文案
  if (FATAL_ERROR_PATTERN.test(message)) return false;
  return TRANSIENT_ERROR_PATTERN.test(message);
}
