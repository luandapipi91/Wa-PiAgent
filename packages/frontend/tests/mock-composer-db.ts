// 在 composer-prefs 加载前 mock composer-db，避免测试里已设置的 bySession 被 loadSession 异步覆盖。
// 必须在任何引入 composer-prefs 的 import 之前导入本模块。
import { mock } from "bun:test";

export const composerDbDefaults: { model: string | null; thinking: string } = { model: null, thinking: "disabled" };
export const composerDbSessions: Record<string, any> = {};

mock.module("../src/store/composer-db", () => ({
  getDefaults: async () => ({ ...composerDbDefaults }),
  setDefaults: async () => {},
  getSessionPrefs: async (sessionId: string) => composerDbSessions[sessionId],
  setSessionPrefs: async () => {},
  deleteSessionPrefs: async () => {},
  getRecordingPrefs: async () => ({}),
  setRecordingPrefs: async () => {},
  getNewSessionIds: async () => ({}),
  setNewSessionIds: async () => {},
}));
