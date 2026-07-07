import { create } from "zustand";
import type { ChatMessage } from "@hiagent/shared";

interface SessionState {
  messagesBySession: Record<string, ChatMessage[]>;
  // upsert：同 id 消息更新（流式增量），不同 id 追加
  append: (msg: ChatMessage) => void;
  // 设置整个会话的消息列表（加载历史会话用，覆盖非追加）
  setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  append: (msg) => set(s => {
    const list = s.messagesBySession[msg.sessionId] ?? [];
    const idx = list.findIndex(m => m.id === msg.id);
    // 同 id 存在 → 更新（流式增量）；不存在 → 追加
    const newList = idx >= 0
      ? list.map((m, i) => i === idx ? msg : m)
      : [...list, msg];
    return {
      messagesBySession: {
        ...s.messagesBySession,
        [msg.sessionId]: newList,
      },
    };
  }),
  // 加载历史消息（merge 而非覆盖——避免覆盖切回时已通过实时事件收到的消息）
  setMessages: (sessionId, messages) => set(s => {
    const existing = s.messagesBySession[sessionId] ?? [];
    const existingIds = new Set(existing.map(m => m.id));
    // 只添加 store 中尚不存在的消息（历史加载 + 实时事件已在 store 中的保留后者）
    const newFromHistory = messages.filter(m => !existingIds.has(m.id));
    return {
      messagesBySession: { ...s.messagesBySession, [sessionId]: [...existing, ...newFromHistory] },
    };
  }),
  clear: () => set({ messagesBySession: {} }),
}));
