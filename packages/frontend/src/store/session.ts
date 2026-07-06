import { create } from "zustand";
import type { ChatMessage } from "hiagent-shared";

interface SessionStore {
  currentAgent: string | null;
  messages: Record<string, ChatMessage[]>;
  selectAgent: (n: string) => void;
  addMessage: (agentName: string, msg: ChatMessage) => void;
}
export const useSession = create<SessionStore>((set) => ({
  currentAgent: null, messages: {},
  selectAgent: (name) => set({ currentAgent: name }),
  addMessage: (agentName, msg) => set((s) => ({
    messages: { ...s.messages, [agentName]: [...(s.messages[agentName] ?? []), msg] },
  })),
}));
