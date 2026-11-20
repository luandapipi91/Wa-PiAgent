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

/** defaults 已改用 localStorage 持久化，清理由 beforeEach 的 localStorage.clear() 负责。
 * 此函数保留为 no-op，避免操作已不存在的 IndexedDB defaults store 报错。 */
async function clearDefaultsStore(): Promise<void> {}

describe("composer-db", () => {
  beforeEach(async () => {
    // 先触发一次数据库初始化，避免后续直接操作 indexedDB 时创建空版本
    await getDefaults();
    await deleteSessionPrefs("test-session");
    await clearDefaultsStore();
    // defaults/recording/newSessionIds 现走 localStorage，需一并清理
    localStorage.clear();
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

  it("stores and retrieves text draft", async () => {
    await setSessionPrefs({
      sessionId: "test-session",
      model: "gpt-4o",
      thinking: "high",
      attachments: [],
      text: "写了一半的草稿",
      updatedAt: Date.now(),
    });
    const prefs = await getSessionPrefs("test-session");
    expect(prefs?.text).toBe("写了一半的草稿");
  });

  it("stores and retrieves empty text draft（清空语义）", async () => {
    await setSessionPrefs({
      sessionId: "test-session",
      model: "gpt-4o",
      thinking: "high",
      attachments: [],
      text: "",
      updatedAt: Date.now(),
    });
    const prefs = await getSessionPrefs("test-session");
    expect(prefs?.text).toBe("");
  });

  it("stores defaults（按模型存思考档）", async () => {
    await setDefaults({
      model: "claude-sonnet",
      thinkingByModel: { "claude-sonnet": "high" },
    });
    const defs = await getDefaults();
    expect(defs.model).toBe("claude-sonnet");
    expect(defs.thinkingByModel["claude-sonnet"]).toBe("high");
  });

  it("无记录时兜底为空模型 + 空模型表", async () => {
    const defs = await getDefaults();
    expect(defs).toEqual({ model: null, thinkingByModel: {} });
  });

  it("兼容旧结构 { model, thinking }：不崩且忽略旧 thinking", async () => {
    localStorage.setItem(
      "wa-pi:composer-defaults",
      JSON.stringify({ model: "old/m1", thinking: "high" }),
    );
    const defs = await getDefaults();
    expect(defs.model).toBe("old/m1");
    expect(defs.thinkingByModel).toEqual({});
  });
});
