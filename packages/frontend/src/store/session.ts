import { create } from "zustand";
import type { SessionMessage } from "@hiagent/shared";

interface SessionState {
  messagesBySession: Record<string, SessionMessage[]>;
  append: (sessionId: string, msg: SessionMessage) => void;
  setMessages: (sessionId: string, messages: SessionMessage[]) => void;
  clear: () => void;
}

// 流式标识：同 agent 同时刻同 role 视为同一条流式增量
function msgKey(m: SessionMessage): string {
  const inner = m.message as any;
  return `${inner.role ?? "custom"}-${inner.timestamp}`;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  append: (sessionId, msg) => set(s => {
    const list = s.messagesBySession[sessionId] ?? [];
    const key = msgKey(msg);
    const idx = list.findIndex(m => msgKey(m) === key);
    const newList = idx >= 0 ? list.map((m, i) => i === idx ? msg : m) : [...list, msg];
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: newList } };
  }),
  setMessages: (sessionId, messages) => set(s => {
    const existing = s.messagesBySession[sessionId] ?? [];
    const existingKeys = new Set(existing.map(msgKey));
    const newFromHistory = messages.filter(m => !existingKeys.has(msgKey(m)));
    const merged = [...existing, ...newFromHistory];
    // 按时间戳排序：首条消息场景下 assistant 流式消息可能先于 session:messages 到达，
    // 导致 setMessages 追进来的 user 消息被排到 assistant 之后
    merged.sort((a, b) => (a.message as any).timestamp - (b.message as any).timestamp);
    return { messagesBySession: { ...s.messagesBySession, [sessionId]: merged } };
  }),
  clear: () => set({ messagesBySession: {} }),
}));
