// @ts-ignore：fake-indexeddb 的 types 在 exports 解析上有问题，运行时无影响
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "bun:test";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import {
  getDefaults,
  setDefaults as dbSetDefaults,
  setSessionPrefs as dbSetSessionPrefs,
} from "../src/store/composer-db";

const DB_NAME = "hiagent-composer";

/** 清空 IndexedDB 中的 sessions 与 defaults store，避免测试间污染 */
async function clearStores(): Promise<void> {
  const request = indexedDB.open(DB_NAME);
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["sessions", "defaults"], "readwrite");
      tx.objectStore("sessions").clear();
      tx.objectStore("defaults").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe("composer-prefs store", () => {
  beforeEach(async () => {
    // 先触发 idb 的数据库初始化，避免后续直接操作 indexedDB 时创建空版本
    await getDefaults();
    await clearStores();
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });
  });

  it("loadDefaults loads defaults from IndexedDB into state", async () => {
    await dbSetDefaults({ model: "claude-sonnet", thinking: "high" });

    await useComposerPrefsStore.getState().loadDefaults();

    expect(useComposerPrefsStore.getState().defaults).toEqual({
      model: "claude-sonnet",
      thinking: "high",
    });
  });

  it("loadSession loads per-session prefs from IndexedDB", async () => {
    await dbSetDefaults({ model: "default-model", thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "s1",
      model: "session-model",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });

    await useComposerPrefsStore.getState().loadSession("s1");

    const state = useComposerPrefsStore.getState();
    expect(state.defaults).toEqual({ model: "default-model", thinking: "disabled" });
    expect(state.bySession["s1"]).toEqual({
      model: "session-model",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
    });
  });

  it("loadSession falls back to defaults when no session record exists", async () => {
    await dbSetDefaults({ model: "fallback-model", thinking: "high" });

    await useComposerPrefsStore.getState().loadSession("missing-session");

    const state = useComposerPrefsStore.getState();
    expect(state.defaults).toEqual({ model: "fallback-model", thinking: "high" });
    expect(state.bySession["missing-session"]).toEqual({
      model: "fallback-model",
      thinking: "high",
      attachments: [],
    });
  });

  it("setDefaults updates state and persists to IndexedDB", async () => {
    useComposerPrefsStore.getState().setDefaults({ model: "persisted-model", thinking: "high" });

    expect(useComposerPrefsStore.getState().defaults).toEqual({
      model: "persisted-model",
      thinking: "high",
    });
    expect(await getDefaults()).toEqual({ model: "persisted-model", thinking: "high" });
  });

  it("updates session prefs and defaults", () => {
    useComposerPrefsStore.getState().setSessionPrefs("s1", { model: "gpt-4o", thinking: "high" });
    const state = useComposerPrefsStore.getState();
    expect(state.bySession["s1"].model).toBe("gpt-4o");
    expect(state.defaults.model).toBe("gpt-4o");
  });
});
