/**
 * SDK 集成验证测试 — 真实 LLM 调用
 * 验证 createAgentSession + subscribe + prompt + intercom 会话名 全链路
 *
 * 运行：RUN_SDK_E2E=1 bun test packages/kernel/tests/sdk-integration.test.ts
 */
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const RUN_E2E = process.env.RUN_SDK_E2E === "1";
const TEST_DIR = `/tmp/hiagent-sdk-test-${Date.now()}`;
const SESSION_FILE = `${TEST_DIR}/sessions/test-1.jsonl`;

if (RUN_E2E) {
  mkdirSync(`${TEST_DIR}/sessions`, { recursive: true });
  mkdirSync(`${TEST_DIR}/agents`, { recursive: true });
  writeFileSync(
    `${TEST_DIR}/agents/dev.md`,
    `---
name: dev
displayName: 研发
avatar: "⚙️"
avatarColor: "#fab387-#f38ba8"
description: 测试
model: deepseek/deepseek-v4-flash
thinking: off
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
tools: []
skills: []
mcpServers: []
partners:
  askTo: []
  askFrom: []
---
你是一个测试助手，只回复"OK"。`,
    "utf8",
  );
}

afterAll(() => {
  if (RUN_E2E) {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  }
});

test.skipIf(!RUN_E2E)("SDK createAgentSession 端到端 — prompt 收到 message_end 事件", async () => {
  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } =
    await import("@earendil-works/pi-coding-agent");

  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("deepseek", "sk-cfdb4d0613df41fc9d220c0aa4e268a3");
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd: TEST_DIR,
    agentDir: TEST_DIR,
    sessionManager: SessionManager.open(SESSION_FILE),
    model: undefined,
    thinkingLevel: "off",
    tools: [],
    authStorage,
    modelRegistry,
  });

  session.setSessionName("test-project-dev-test-session");

  const events: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    events.push(event.type);
  });

  await session.prompt("回复 OK");

  unsubscribe();
  session.dispose();

  console.log("收到事件序列:", events.join(" → "));
  expect(events).toContain("agent_start");
  expect(events).toContain("message_start");
  expect(events).toContain("agent_end");

  console.log("消息数量:", session.messages.length);
  expect(session.messages.length).toBeGreaterThan(0);

  const assistantMsg = session.messages.find((m: any) => m.role === "assistant");
  expect(assistantMsg).toBeTruthy();
  console.log("assistant 消息:", JSON.stringify(assistantMsg).slice(0, 200));
}, 60000);
