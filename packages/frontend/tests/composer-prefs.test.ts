// @ts-ignore：fake-indexeddb 的 types 在 exports 解析上有问题，运行时无影响
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "bun:test";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import {
  getDefaults,
  getNewSessionIds,
  setDefaults as dbSetDefaults,
  setNewSessionIds as dbSetNewSessionIds,
  setSessionPrefs as dbSetSessionPrefs,
} from "../src/store/composer-db";

const DB_NAME = "wa-pi-composer";

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
    // defaults/recording/newSessionIds 现走 localStorage，需一并清理
    localStorage.clear();
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
      newSessionIds: {},
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

  it("重启往返：setDefaults({thinking}) → 重置内存态 → loadDefaults 应恢复存储的 thinking", async () => {
    // 模拟用户在新建页设置思考强度
    useComposerPrefsStore.getState().setDefaults({ thinking: "high" });
    // 等待 fire-and-forget 的 IndexedDB 写入完成
    await new Promise((r) => setTimeout(r, 10));

    // 模拟软件重启：zustand 内存态回到初始值（IndexedDB 数据保留）
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
      newSessionIds: {},
    });

    // 重新加载（NewSessionPane 挂载时触发）
    await useComposerPrefsStore.getState().loadDefaults();

    // 关键断言：思考强度应从 IndexedDB 恢复为 high，而非停留在 disabled
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("high");
  });

  it("setNewSessionId persists new session ids to IndexedDB", async () => {
    await dbSetNewSessionIds({ p1: "ns-1" });

    await useComposerPrefsStore.getState().loadDefaults();

    expect(useComposerPrefsStore.getState().newSessionIds).toEqual({ p1: "ns-1" });
    expect(await getNewSessionIds()).toEqual({ p1: "ns-1" });
  });

  it("loadSession 不应覆盖已由 setSessionPrefs 设置的 prefs（竞态：auto-select 先于 loadSession 完成）", async () => {
    await dbSetDefaults({ model: null, thinking: "disabled" });

    // 模拟：auto-select 先触发 setSessionPrefs
    useComposerPrefsStore.getState().setSessionPrefs("new-session", { model: "openai/gpt-4o" });

    // 模拟：loadSession 在 setSessionPrefs 之后才完成（此时 DB 中仍无记录）
    await useComposerPrefsStore.getState().loadSession("new-session");

    // loadSession 不应覆盖 auto-select 结果
    const state = useComposerPrefsStore.getState();
    expect(state.bySession["new-session"].model).toBe("openai/gpt-4o");
  });

  it("复现：新会话设 max → 切到老会话(off) → 重启后 defaults 应保持 max", async () => {
    // 老会话已有 off 偏好
    await dbSetDefaults({ model: null, thinking: "disabled" });
    await dbSetSessionPrefs({
      sessionId: "old-session", model: null, thinking: "disabled",
      attachments: [], updatedAt: Date.now(),
    });

    // 1. 用户在新会话设置思考强度 max（NewSessionPane.setDefaults）
    useComposerPrefsStore.getState().setDefaults({ thinking: "max" });
    await new Promise((r) => setTimeout(r, 10)); // 等 fire-and-forget 写入完成

    // 2. 切到老会话：Composer 挂载 → loadSession(old-session)
    await useComposerPrefsStore.getState().loadSession("old-session");

    // 2b. 在老会话里改了 model（Composer.setModel 走 setSessionPrefs）
    useComposerPrefsStore.getState().setSessionPrefs("old-session", { model: "openai/gpt-4o" });
    await new Promise((r) => setTimeout(r, 10));

    // 3. 软件重启：内存态重置，IndexedDB 保留
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {}, newSessionIds: {},
    });

    // 4. 重开 → NewSessionPane 挂载 → loadDefaults
    await useComposerPrefsStore.getState().loadDefaults();

    // 关键断言：用户在新会话设的 max 应被保留，而非被老会话的 off 覆盖
    expect(useComposerPrefsStore.getState().defaults.thinking).toBe("max");
  });
});
