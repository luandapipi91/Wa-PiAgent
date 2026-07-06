import { create } from "zustand";
import type { ChatMessage } from "hiagent-shared";

export interface SessionItem {
  agentName: string;
  displayName: string;
  avatar: string;
  lastMessage: string;
  lastActivity: number;
}

interface SessionStore {
  currentAgent: string | null;
  messages: Record<string, ChatMessage[]>;
  sessions: SessionItem[];
  selectAgent: (name: string, displayName?: string, avatar?: string) => void;
  addMessage: (agentName: string, msg: ChatMessage) => void;
}

export const useSession = create<SessionStore>((set) => ({
  currentAgent: null,
  messages: {},
  sessions: [],

  selectAgent: (name, displayName, avatar) => set((s) => {
    // Empty name means "new session" — go back to launch screen
    if (!name) return { currentAgent: null };
    const existing = s.sessions.find(i => i.agentName === name);
    if (existing) {
      return {
        currentAgent: name,
        sessions: [
          { ...existing, lastActivity: Date.now() },
          ...s.sessions.filter(i => i.agentName !== name),
        ],
      };
    }
    // New session
    const newSession: SessionItem = {
      agentName: name,
      displayName: displayName ?? name,
      avatar: avatar ?? "🤖",
      lastMessage: "",
      lastActivity: Date.now(),
    };
    return {
      currentAgent: name,
      sessions: [newSession, ...s.sessions],
    };
  }),

  addMessage: (agentName, msg) => set((s) => {
    const existing = s.sessions.find(i => i.agentName === agentName);
    const updatedSession: SessionItem = existing
      ? { ...existing, lastMessage: msg.text.slice(0, 50), lastActivity: msg.timestamp }
      : { agentName, displayName: agentName, avatar: "🤖", lastMessage: msg.text.slice(0, 50), lastActivity: msg.timestamp };

    return {
      messages: { ...s.messages, [agentName]: [...(s.messages[agentName] ?? []), msg] },
      sessions: [
        updatedSession,
        ...s.sessions.filter(i => i.agentName !== agentName),
      ],
    };
  }),
}));
