// ask_user_question 前端派生状态：从 messagesBySession 派生 pending 提问 + 有效的会话状态。
import { useMemo } from "react";
import { useSessionStore } from "./session";
import type { AgentStatus, AgentName, AskParams, SessionMessage } from "@hiagent/shared";

export interface PendingAsk {
  toolCallId: string;
  agentName?: AgentName;
  params: AskParams;
}

/** 从一条会话的消息里找出「无 toolResult 的 ask_user_question 工具调用」。纯函数。 */
export function selectPendingAsks(messages: SessionMessage[]): PendingAsk[] {
  const answered = new Set<string>();
  for (const sm of messages) {
    const m = sm.message as any;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }
  const pending: PendingAsk[] = [];
  for (const sm of messages) {
    const m = sm.message as any;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === "toolCall" && b.name === "ask_user_question" && typeof b.id === "string" && !answered.has(b.id)) {
        pending.push({ toolCallId: b.id, agentName: sm.agentName, params: b.arguments as AskParams });
      }
    }
  }
  return pending;
}

/** pending 提问存在时强制 blocked，否则透传原始状态。纯函数。 */
export function selectEffectiveStatus(raw: AgentStatus, hasPending: boolean): AgentStatus {
  return hasPending ? "blocked" : raw;
}

/** hook：订阅某会话的 pending 提问列表。 */
export function usePendingAsks(sessionId: string): PendingAsk[] {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? EMPTY);
  return useMemo(() => selectPendingAsks(messages), [messages]);
}

/** hook：某会话是否处于「等待用户回答」阻塞态。 */
export function useIsBlocked(sessionId: string): boolean {
  return usePendingAsks(sessionId).length > 0;
}

const EMPTY: SessionMessage[] = [];
