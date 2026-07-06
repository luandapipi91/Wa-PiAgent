import { create } from "zustand";
import type { ChatMessage } from "@hiagent/shared";

interface SessionState {
  messagesBySession: Record<string, ChatMessage[]>;
  append: (msg: ChatMessage) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  messagesBySession: {},
  append: (msg) => set(s => ({
    messagesBySession: {
      ...s.messagesBySession,
      [msg.sessionId]: [...(s.messagesBySession[msg.sessionId] ?? []), msg],
    },
  })),
  clear: () => set({ messagesBySession: {} }),
}));
