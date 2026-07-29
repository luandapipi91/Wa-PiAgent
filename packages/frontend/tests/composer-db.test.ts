// 注册 fake IndexedDB（happy-dom 未提供），供 composer-db 单元测试使用
// @ts-ignore：fake-indexeddb 的 types 在 exports 解析上有问题，运行时无影响
import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach } from "bun:test";
import {
  getSessionPrefs,
  setSessionPrefs,
  getDefaults,
  setDefaults,
  deleteSessionPrefs,
} from "../src/store/composer-db";

const DB_NAME = "wa-pi-composer";

/** 清空 defaults store，用于测试 getDefaults 的兜底路径 */
async function clearDefaultsStore(): Promise<void> {
  const request = indexedDB.open(DB_NAME);
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("defaults", "readwrite");
      const store = tx.objectStore("defaults");
      store.clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe("composer-db", () => {
  beforeEach(async () => {
    // 先触发一次数据库初始化，避免后续直接操作 indexedDB 时创建空版本
    await getDefaults();
    await deleteSessionPrefs("test-session");
    await clearDefaultsStore();
  });

  it("stores and retrieves session prefs", async () => {
    await setSessionPrefs({
      sessionId: "test-session",
      model: "gpt-4o",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });
    const prefs = await getSessionPrefs("test-session");
    expect(prefs?.model).toBe("gpt-4o");
    expect(prefs?.thinking).toBe("high");
    expect(prefs?.attachments).toHaveLength(1);
  });

  it("deletes session prefs", async () => {
    await setSessionPrefs({
      sessionId: "test-session",
      model: "gpt-4o",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });
    expect(await getSessionPrefs("test-session")).toBeDefined();

    await deleteSessionPrefs("test-session");

    expect(await getSessionPrefs("test-session")).toBeUndefined();
  });

  it("stores defaults", async () => {
    await setDefaults({ model: "claude-sonnet", thinking: "disabled" });
    const defs = await getDefaults();
    expect(defs.model).toBe("claude-sonnet");
    expect(defs.thinking).toBe("disabled");
  });

  it("returns default fallback when no defaults are stored", async () => {
    const defs = await getDefaults();
    expect(defs).toEqual({ model: null, thinking: "disabled" });
  });
});
