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
  setMessages: (sessionId, messages) => set(s => {
    // 按 id 去重（流式消息各版本在磁盘可能重复，加载时合并）
    const seen = new Set<string>();
    const deduped = messages.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    return {
      messagesBySession: { ...s.messagesBySession, [sessionId]: deduped },
    };
  }),
  clear: () => set({ messagesBySession: {} }),
}));
