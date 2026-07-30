import { create } from "zustand";
import type { AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { getDefaults, getNewSessionIds, getSessionPrefs, setDefaults, setNewSessionIds, setSessionPrefs as dbSetSessionPrefs } from "./composer-db";

// Hydration guard：标记 defaults 是否已从持久层加载。
// store 初始内存态 thinking="disabled"，而 loadDefaults 是异步的——若在其完成前
// 触发 setDefaults/setSessionPrefs（如用户改 model、附件 auto-select），会拿初始 disabled
// 当"当前 defaults"写回 localStorage，覆盖用户上次存的 high/max。这是"重启后思考强度变 disabled"的根因。
// 守卫：未 hydrate 前持久化函数只更新内存、不写回；hydrate 后恢复正常持久化。
let defaultsHydrated = false;

/** 测试专用：重置 hydration 标志（模拟软件重启后尚未 loadDefaults 的状态） */
export function _resetDefaultsHydration(): void { defaultsHydrated = false; }

export interface SessionPrefs {
  model: string | null;
  // thinking 可选：undefined 表示用户未在此会话显式设置过，组件读取时回退到 defaults.thinking
  thinking?: ThinkingLevel;
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
      // localStorage 是 model 的权威来源（用户上次显式选择并持久化）；
      // 仅当持久层无值（用户从未选过）时，才用内存值兜底——
      // 这通常发生在 NewSessionPane 挂载早期、ModelSelector 因 value=null 触发 auto-select
      // 把内存 model 设成"第一个模型"时：此时若 localStorage 有真实值必须优先恢复，
      // 否则会被 auto-select 抢先污染（重启后模型被重置为第一个的根因）。
      next.defaults = {
        model: defs.model ?? s.defaults.model,
        thinking: defs.thinking,
      };
      const changed =
        Object.keys(ids).length !== Object.keys(s.newSessionIds).length ||
        Object.entries(ids).some(([k, v]) => s.newSessionIds[k] !== v);
      if (changed) next.newSessionIds = ids;
      return next as ComposerPrefsState;
    });
    defaultsHydrated = true; // 已从持久层恢复 defaults，后续写入可安全持久化
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
            // thinking 仅在用户显式设置过时才有值，否则保持 undefined
            // 组件读取时回退到 defaults.thinking（而非硬编码 disabled）
            ...(stored?.thinking !== undefined ? { thinking: stored.thinking } : {}),
            attachments: stored?.attachments ?? [],
          },
        },
      };
    });
    defaultsHydrated = true; // loadSession 内部也读了 defaults，同样标记 hydrate 完成
  },

  setSessionPrefs: (sessionId, prefs) => {
    set(s => {
      const current = s.bySession[sessionId] ?? { model: s.defaults.model, thinking: s.defaults.thinking, attachments: [] };
      const next = { ...current, ...prefs };
      void dbSetSessionPrefs({ sessionId, ...next, thinking: next.thinking ?? s.defaults.thinking, updatedAt: Date.now() });
      // 仅把用户本次显式修改的字段（prefs 参数）同步到全局 defaults，
      // 而非用整个 session prefs 覆盖——否则切到老会话改 model 时，
      // 会把老会话的 thinking（可能为 disabled）误写进 defaults，污染新会话默认值。
      const newDefaults = { ...s.defaults };
      if (prefs.model !== undefined) newDefaults.model = prefs.model;
      if (prefs.thinking !== undefined) newDefaults.thinking = prefs.thinking;
      // hydration guard：未从持久层加载 defaults 前，s.defaults.thinking 还是初始 disabled，
      // 此时写回会用 disabled 覆盖用户上次存的高强度档位（重启后思考强度被重置的根因）
      if (defaultsHydrated) void setDefaults(newDefaults);
      return {
        bySession: { ...s.bySession, [sessionId]: next },
        defaults: newDefaults,
      };
    });
  },

  setDefaults: (prefs) => {
    set(s => {
      const next = { ...s.defaults, ...prefs };
      if (defaultsHydrated) void setDefaults(next);
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
