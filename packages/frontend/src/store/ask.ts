// ask_user_question 前端派生状态：从 messagesBySession 派生 pending 提问 + 有效的会话状态。
import { useMemo } from "react";
import { useSessionStore } from "./session";
import type { AgentName, AskParams, AskReply, SessionMessage } from "@wa-pi/shared";

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

/** 便签快捷选择 → 完整 AskReply。任一问题未选中返回 null（不可提交）。
 *  后端契约：/answer 一次提交整个 toolCallId 的全部问题，不能逐问题提交。 */
export function buildQuickReply(
	params: AskParams,
	quickSel: Record<number, Set<string>>,
): AskReply | null {
	const replies = params.questions.map((q, qi) => {
		const sel = quickSel[qi];
		if (!sel || sel.size === 0) return null;
		return { questionIndex: qi, selected: [...sel] };
	});
	if (replies.some((r) => r === null)) return null;
	return { replies: replies as AskReply["replies"] };
}
