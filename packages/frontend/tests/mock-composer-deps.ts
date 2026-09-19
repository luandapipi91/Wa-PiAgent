// Composer 测试依赖的 mock：api-client 与 composer-db。
// 单独抽成一个模块并在 Composer.test.tsx 最顶部 import，确保 mock 在 Composer 加载前注册。
import { mock } from "bun:test";
import { useComposerPrefsStore } from "../src/store/composer-prefs";

export const sent: any[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: (_path: string, body?: any) => { sent.push({ path: _path, body }); return Promise.resolve({}); },
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

mock.module("../src/store/composer-db", () => ({
  getDefaults: async () => {
    const s = useComposerPrefsStore.getState();
    return {
      model: s.bySession.s1?.model ?? s.defaults.model,
      thinking: s.bySession.s1?.thinking ?? s.defaults.thinking,
    };
  },
  setDefaults: async () => {},
  getSessionPrefs: async (sessionId: string) => useComposerPrefsStore.getState().bySession[sessionId],
  setSessionPrefs: async () => {},
  deleteSessionPrefs: async () => {},
  getRecordingPrefs: async () => ({}),
  setRecordingPrefs: async () => {},
  getNewSessionIds: async () => ({}),
  setNewSessionIds: async () => {},
}));
