import { create } from "zustand";
import type { AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { getDefaults, getNewSessionIds, getSessionPrefs, setDefaults, setNewSessionIds, setSessionPrefs as dbSetSessionPrefs } from "./composer-db";

export interface SessionPrefs {
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
}

interface ComposerPrefsState {
  defaults: { model: string | null; thinking: ThinkingLevel };
  bySession: Record<string, SessionPrefs>;
  newSessionIds: Record<string, string>;
  loadDefaults: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  setSessionPrefs: (sessionId: string, prefs: Partial<SessionPrefs>) => void;
  setDefaults: (prefs: Partial<{ model: string | null; thinking: ThinkingLevel }>) => void;
  setNewSessionId: (key: string, id: string) => void;
  clearNewSessionId: (key: string) => void;
}

export const useComposerPrefsStore = create<ComposerPrefsState>((set) => ({
  defaults: { model: null, thinking: "disabled" },
  bySession: {},
  newSessionIds: {},

  loadDefaults: async () => {
    const [defs, ids] = await Promise.all([getDefaults(), getNewSessionIds()]);
    set(s => {
      const next: Partial<ComposerPrefsState> = {};
      // 始终使用存储的 thinking；model 仅在用户已选中时保留内存值（防止异步竞速覆盖为 null）
      next.defaults = {
        model: s.defaults.model != null ? s.defaults.model : defs.model,
        thinking: defs.thinking,
      };
      const changed =
        Object.keys(ids).length !== Object.keys(s.newSessionIds).length ||
        Object.entries(ids).some(([k, v]) => s.newSessionIds[k] !== v);
      if (changed) next.newSessionIds = ids;
      return next as ComposerPrefsState;
    });
  },

  loadSession: async (sessionId) => {
    const defaults = await getDefaults();
    const stored = await getSessionPrefs(sessionId);
    set(s => {
      // 异步 gap 期间 setSessionPrefs 可能已设置值（如 auto-select），不要覆盖
      const existing = s.bySession[sessionId];
      if (existing) {
        // 保留已有 prefs，仅更新 defaults（若 defaults 加载延迟）
        if (s.defaults.model == null && defaults.model != null) return { defaults };
        return {};
      }
      return {
        defaults,
        bySession: {
          ...s.bySession,
          [sessionId]: {
            model: stored?.model ?? defaults.model,
            thinking: stored?.thinking ?? defaults.thinking,
            attachments: stored?.attachments ?? [],
          },
        },
      };
    });
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

  setNewSessionId: (key, id) => {
    set(s => {
      if (s.newSessionIds[key] === id) return s;
      const next = { ...s.newSessionIds, [key]: id };
      void setNewSessionIds(next);
      return { newSessionIds: next };
    });
  },
  clearNewSessionId: (key) => {
    set(s => {
      if (!(key in s.newSessionIds)) return s;
      const next = { ...s.newSessionIds };
      delete next[key];
      void setNewSessionIds(next);
      return { newSessionIds: next };
    });
  },
}));
