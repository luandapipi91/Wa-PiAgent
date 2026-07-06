import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/session-store";
import type { ChatMessage, AskItem } from "@hiagent/shared";

function tempDir() {
  return join(import.meta.dir, ".tmp-sessions-" + Math.random().toString(36).slice(2));
}

const mkMsg = (id: string, sessionId: string, text: string): ChatMessage => ({
  id, sessionId, role: "user", text, timestamp: 0,
});

test("appendMessage 持久化并可读回", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  await store.appendMessage("s1", mkMsg("m1", "s1", "你好"));
  const msgs = await store.loadMessages("s1");
  expect(msgs).toHaveLength(1);
  expect(msgs[0].text).toBe("你好");
  rmSync(dir, { recursive: true, force: true });
});

test("loadMessages 不存在返回空", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  expect(await store.loadMessages("nope")).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("appendAsk + resolveAsk", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  const ask: AskItem = {
    messageId: "a1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  };
  await store.appendAsk("s1", ask);
  let asks = await store.loadAsks("s1");
  expect(asks[0].resolved).toBe(false);
  await store.resolveAsk("s1", "a1");
  asks = await store.loadAsks("s1");
  expect(asks[0].resolved).toBe(true);
  expect(asks[0].resolvedAt).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});
