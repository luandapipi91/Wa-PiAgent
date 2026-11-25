// ask_user_question 前端派生状态：从 messagesBySession 派生 pending 提问 + 有效的会话状态。
import { useMemo } from "react";
import { create } from "zustand";
import { useSessionStore } from "./session";
import type { AgentName, AskParams, AskReply, AskState, SessionMessage } from "@wa-pi/shared";

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

/** 卡片形态：open=等用户回答；closed=已终结（答完/取消，toolResult 可能尚在途）；stale=内核查无此问（重启残留）。 */
export type AskVerdict = "open" | "closed" | "stale";

/** 双检状态 → 卡片形态。answered/cancelled 都不算失效——回执可能被并行工具批次扣住数分钟。 */
export function classifyAsk(state: AskState | undefined): AskVerdict {
	if (state === "pending") return "open";
	if (state === "answered" || state === "cancelled") return "closed";
	return "stale";
}

const DISMISS_STORAGE_KEY = "wa-pi:ask-dismissed";
/** 单会话最多保留的关闭记录（toolCallId 不会回收，防无界增长） */
const MAX_DISMISSED_PER_SESSION = 50;

/** 用户本地关闭的提问（失效卡片 / 已终结但回执未到）。
 *  失效提问取消是 no-op、也不会再产生 toolResult，卡片永远等不到消息流卸载信号，
 *  所以必须允许本地关闭；标记按会话隔离并持久化，否则切会话/刷新会把关闭记录丢掉、卡片复活。 */
interface DismissedAskStore {
	/** sessionId → 已关闭的 toolCallId */
	bySession: Record<string, string[]>;
	dismiss: (sessionId: string, toolCallId: string) => void;
	/** 回收本会话里已不在 pending 的标记（其它会话的记录一律不动） */
	prune: (sessionId: string, aliveIds: Iterable<string>) => void;
	isDismissed: (sessionId: string, toolCallId: string) => boolean;
}

function saveDismissed(bySession: Record<string, string[]>): void {
	try {
		localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(bySession));
	} catch {
		/* 无 localStorage（隐私模式/非浏览器环境）：静默降级为仅内存 */
	}
}

/** 从 localStorage 恢复关闭标记（模块加载时调用一次；刷新后仍生效）。 */
export function loadDismissedFromStorage(): void {
	try {
		const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return;
		const bySession: Record<string, string[]> = {};
		for (const [sid, ids] of Object.entries(parsed as Record<string, unknown>)) {
			if (!Array.isArray(ids)) continue;
			const clean = ids.filter((x): x is string => typeof x === "string");
			if (clean.length > 0) bySession[sid] = clean;
		}
		useDismissedAskStore.setState({ bySession });
	} catch {
		/* 坏数据当没有：不因缓存损坏而抛错 */
	}
}

export const useDismissedAskStore = create<DismissedAskStore>((set, get) => ({
	bySession: {},
	dismiss: (sessionId, toolCallId) =>
		set((s) => {
			const cur = s.bySession[sessionId] ?? [];
			if (cur.includes(toolCallId)) return s;
			const next = {
				...s.bySession,
				[sessionId]: [...cur, toolCallId].slice(-MAX_DISMISSED_PER_SESSION),
			};
			saveDismissed(next);
			return { bySession: next };
		}),
	prune: (sessionId, aliveIds) =>
		set((s) => {
			const cur = s.bySession[sessionId];
			if (!cur || cur.length === 0) return s;
			const alive = new Set(aliveIds);
			const kept = cur.filter((id) => alive.has(id));
			if (kept.length === cur.length) return s;
			const next = { ...s.bySession };
			if (kept.length === 0) delete next[sessionId];
			else next[sessionId] = kept;
			saveDismissed(next);
			return { bySession: next };
		}),
	isDismissed: (sessionId, toolCallId) =>
		(get().bySession[sessionId] ?? []).includes(toolCallId),
}));

loadDismissedFromStorage();

/** hook：某会话待回答的提问（已本地关闭的不计入）。 */
export function useVisibleAsks(sessionId: string): PendingAsk[] {
	const pending = usePendingAsks(sessionId);
	const dismissed = useDismissedAskStore((s) => s.bySession[sessionId]);
	return useMemo(
		() =>
			!dismissed || dismissed.length === 0
				? pending
				: pending.filter((a) => !dismissed.includes(a.toolCallId)),
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
