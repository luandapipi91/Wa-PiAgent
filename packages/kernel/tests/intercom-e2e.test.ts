/**
 * 验证 pi-intercom 扩展在 SDK 模式下真正加载 + intercom 工具可用
 * 运行：RUN_INTERCOM_E2E=1 bun test packages/kernel/tests/intercom-e2e.test.ts
 */
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const RUN = process.env.RUN_INTERCOM_E2E === "1";
const TEST_DIR = `/tmp/hiagent-intercom-e2e-${Date.now()}`;

if (RUN) {
  mkdirSync(`${TEST_DIR}/sessions`, { recursive: true });
  mkdirSync(`${TEST_DIR}/agents`, { recursive: true });
  writeFileSync(`${TEST_DIR}/auth.json`, JSON.stringify({
    deepseek: { type: "api_key", key: "sk-cfdb4d0613df41fc9d220c0aa4e268a3" },
  }), "utf8");
  writeFileSync(`${TEST_DIR}/agents/dev.md`, `---
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
你是测试助手。`, "utf8");
}

afterAll(() => { if (RUN) try { rmSync(TEST_DIR, { recursive: true }); } catch {} });

test.skipIf(!RUN)("pi-intercom 扩展加载 + intercom 工具注册", async () => {
  const { ensureIntercomInstalled } = await import("../src/intercom-setup");
  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");

  // 1. 先调 ensureIntercomInstalled 写 settings.json（本地路径）
  await ensureIntercomInstalled(TEST_DIR);

  // 2. 创建 session（DefaultResourceLoader 会从 settings.json 读 packages 加载 pi-intercom）
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("deepseek", "sk-cfdb4d0613df41fc9d220c0aa4e268a3");
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session, extensionsResult } = await createAgentSession({
    cwd: TEST_DIR,
    agentDir: TEST_DIR,
    sessionManager: SessionManager.open(`${TEST_DIR}/sessions/intercom.jsonl`),
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
  });

  // 3. 验证扩展加载无错误
  console.log("扩展数:", extensionsResult.extensions.length);
  console.log("扩展错误:", extensionsResult.errors);
  expect(extensionsResult.errors.length).toBe(0);

  // 4. 验证 intercom 工具已注册
  const tools = session.agent.state.tools;
  const toolNames = tools.map((t: any) => t.name);
  console.log("工具列表:", toolNames);
  expect(toolNames).toContain("intercom");

  // 5. 验证 setSessionName 可用（intercom 会话名）
  session.setSessionName("test-project-dev-test");
  console.log("session name:", session.getSessionName?.());

  session.dispose();
  console.log("✅ pi-intercom 扩展加载成功，intercom 工具已注册");
}, 30000);
