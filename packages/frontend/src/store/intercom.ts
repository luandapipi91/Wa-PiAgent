import { create } from "zustand";
import type { AskItem } from "@hiagent/shared";

interface IntercomState {
  asksBySession: Record<string, AskItem[]>;
  addAsk: (ask: AskItem) => void;
  resolveAsk: (sessionId: string, id: string) => void;
}

export const useIntercomStore = create<IntercomState>((set) => ({
  asksBySession: {},
  addAsk: (ask) => set(s => ({
    asksBySession: {
      ...s.asksBySession,
      [ask.sessionId]: [...(s.asksBySession[ask.sessionId] ?? []), ask],
    },
  })),
  resolveAsk: (sessionId, id) => set(s => ({
    asksBySession: {
      ...s.asksBySession,
      [sessionId]: (s.asksBySession[sessionId] ?? []).map(a =>
        a.messageId === id ? { ...a, resolved: true, resolvedAt: Date.now() } : a
      ),
    },
  })),
}));
