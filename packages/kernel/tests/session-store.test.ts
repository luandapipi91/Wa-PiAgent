import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/session-store";
import type { AskItem } from "@hiagent/shared";

function tempDir() {
  return join(import.meta.dir, ".tmp-sessions-" + Math.random().toString(36).slice(2));
}

// 注：messages 部分（loadMessages/appendMessage）已废弃，历史消息改从 Pi session 拉。
// 这里只保留 asks 部分（Task 5 随 broker-proxy 删除）。
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
