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

describe("composer-db", () => {
  beforeEach(async () => {
    await deleteSessionPrefs("test-session");
    await setDefaults({ model: null, thinking: "disabled" });
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

  it("stores defaults", async () => {
    await setDefaults({ model: "claude-sonnet", thinking: "disabled" });
    const defs = await getDefaults();
    expect(defs.model).toBe("claude-sonnet");
  });
});
