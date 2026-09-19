// ask_user_question 前端派生状态：从 messagesBySession 派生 pending 提问 + 有效的会话状态。
import { useMemo } from "react";
import { create } from "zustand";
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

/** 用户本地关闭的提问 id（toolCallId 全局唯一，不按会话分组）。
 *  失效提问（内核 registry 已无此条目）取消是 no-op、也不会再产生 toolResult，
 *  卡片永远等不到消息流卸载信号；允许用户手动关闭，仅影响前端渲染与阻塞判定，不回写后端。 */
interface DismissedAskStore {
  ids: Set<string>;
  dismiss: (toolCallId: string) => void;
  /** 回收：只保留仍存在于 pending 列表里的 id（toolResult 到达后自动清理，避免集合无界增长） */
  prune: (aliveIds: Iterable<string>) => void;
}

export const useDismissedAskStore = create<DismissedAskStore>((set) => ({
  ids: new Set<string>(),
  dismiss: (toolCallId) =>
    set((s) => {
      if (s.ids.has(toolCallId)) return s;
      const next = new Set(s.ids);
      next.add(toolCallId);
      return { ids: next };
    }),
  prune: (aliveIds) =>
    set((s) => {
      if (s.ids.size === 0) return s;
      const alive = new Set(aliveIds);
      const next = new Set([...s.ids].filter((id) => alive.has(id)));
      return next.size === s.ids.size ? s : { ids: next };
    }),
}));

/** hook：某会话待回答的提问（已本地关闭的不计入）。 */
export function useVisibleAsks(sessionId: string): PendingAsk[] {
  const pending = usePendingAsks(sessionId);
  const dismissed = useDismissedAskStore(s => s.ids);
  return useMemo(
    () =>
      dismissed.size === 0
        ? pending
        : pending.filter(a => !dismissed.has(a.toolCallId)),
    [pending, dismissed],
  );
}

/** hook：某会话是否处于「等待用户回答」阻塞态（已本地关闭的提问不再阻塞输入）。 */
export function useIsBlocked(sessionId: string): boolean {
  return useVisibleAsks(sessionId).length > 0;
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
