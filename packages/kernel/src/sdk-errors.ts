// 从 SDK 流式事件中提取「运行时错误」文案。
//
// 背景：SDK 契约规定 provider/model/运行时失败**不抛异常**，而是把错误
// 编码进流——以一条 stopReason === "error"（带 errorMessage）的 AssistantMessage
// 收尾，经 message_end 事件透出。因此 ws-server 里包住 session.prompt() 的
// try/catch 永远抓不到这类失败，错误只会以 sdk:event 流到前端。
// 前端又不读 stopReason/errorMessage，导致「选了不可用模型发消息 → 静默无回复」。
//
// 修复：kernel 的 onEvent 在透传 sdk:event 的同时，用本函数检测这类错误事件，
// 若命中则额外广播一条 {type:"error"}，复用前端已有的红色 ⚠️ 渲染管线。
//
// 只在 message_end 兜口：每条消息（无论成败）都会发一次 message_end，
// 在此兜口可保证「每条失败消息恰好报一次错」，不会因 SDK 的 message_update
// error 变体或内部重试而重复告警。

import type { SDKEvent } from "@hiagent/shared";

/** errorMessage 缺失时的兜底文案（例如某些 provider 不回具体错误信息） */
const FALLBACK_MESSAGE = "模型调用失败，请检查模型与 Provider 配置（模型不可用或鉴权失败）";

/**
 * 从 SDK 事件中提取运行时错误文案。
 * @returns 错误文案（有 errorMessage 用之，否则兜底）；非错误事件返回 null。
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
