import { create } from "zustand";
import type { AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { getDefaults, getSessionPrefs, setDefaults, setSessionPrefs as dbSetSessionPrefs } from "./composer-db";

export interface SessionPrefs {
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
}

interface ComposerPrefsState {
  defaults: { model: string | null; thinking: ThinkingLevel };
  bySession: Record<string, SessionPrefs>;
  loadDefaults: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  setSessionPrefs: (sessionId: string, prefs: Partial<SessionPrefs>) => void;
  setDefaults: (prefs: Partial<{ model: string | null; thinking: ThinkingLevel }>) => void;
}

export const useComposerPrefsStore = create<ComposerPrefsState>((set) => ({
  defaults: { model: null, thinking: "disabled" },
  bySession: {},

  loadDefaults: async () => {
    const defs = await getDefaults();
    set({ defaults: defs });
  },

  loadSession: async (sessionId) => {
    const defaults = await getDefaults();
    const stored = await getSessionPrefs(sessionId);
    set(s => ({
      defaults,
      bySession: {
        ...s.bySession,
        [sessionId]: {
          model: stored?.model ?? defaults.model,
          thinking: stored?.thinking ?? defaults.thinking,
          attachments: stored?.attachments ?? [],
        },
      },
    }));
  },

  setSessionPrefs: (sessionId, prefs) => {
    set(s => {
      const current = s.bySession[sessionId] ?? { model: s.defaults.model, thinking: s.defaults.thinking, attachments: [] };
      const next = { ...current, ...prefs };
      void dbSetSessionPrefs({ sessionId, ...next, updatedAt: Date.now() });
      const newDefaults = { model: next.model, thinking: next.thinking };
      void setDefaults(newDefaults);
      return {
        bySession: { ...s.bySession, [sessionId]: next },
        defaults: newDefaults,
      };
    });
  },

  setDefaults: (prefs) => {
    set(s => {
      const next = { ...s.defaults, ...prefs };
      void setDefaults(next);
      return { defaults: next };
    });
  },
}));
