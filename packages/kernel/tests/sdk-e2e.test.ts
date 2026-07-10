/**
 * SDK + WS 端到端验证 — 真实 LLM 调用
 * 验证 AgentManager → ws-server → WS 广播 sdk:event 全链路
 *
 * 运行：HIAGENT_DIR=/tmp/hiagent-e2e bun test packages/kernel/tests/sdk-e2e.test.ts
 * 需要预先在 $HIAGENT_DIR/auth.json 配置 deepseek API key
 */
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

// 仅在有 HIAGENT_DIR 且 auth.json 存在时运行（避免普通 bun test 误跑）
const RUN_E2E = process.env.HIAGENT_DIR && existsSync(`${process.env.HIAGENT_DIR}/auth.json`);
test.skipIf(!RUN_E2E)("WS 端到端 — 发 prompt 收到 sdk:event 事件流", async () => {

// 必须在 import kernel 模块前由测试 runner 读到 HIAGENT_DIR（bun test 会先加载 preload）
// 这里用 process.env.HIAGENT_DIR 已在 bun 启动时注入
const TEST_DIR = process.env.HIAGENT_DIR || `/tmp/hiagent-e2e-${Date.now()}`;
process.env.HIAGENT_DIR = TEST_DIR;

// 准备目录
mkdirSync(`${TEST_DIR}/sessions`, { recursive: true });
mkdirSync(`${TEST_DIR}/agents`, { recursive: true });

// 写 agent 配置
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

let server: any;
let ws: WebSocket;

afterAll(async () => {
  try { ws?.close(); } catch {}
  try { await server?.stop(); } catch {}
});

  const { ConfigStore } = await import("../src/config-store");
  const { ProjectStore } = await import("../src/project-store");
  const { ProviderStore } = await import("../src/provider-store");
  const { SkillManager } = await import("../src/skill-manager");
  const { AgentManager } = await import("../src/agent-manager");
  const { WSServer } = await import("../src/ws-server");

  const configStore = new ConfigStore();
  const projectStore = new ProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: TEST_DIR });
  const providerStore = new ProviderStore();
  const skillManager = new SkillManager(TEST_DIR);

  // 验证 agent 配置能读到
  const devConfig = await configStore.getAgent("dev");
  console.log("[test] dev model:", devConfig?.model);
  if (!devConfig) throw new Error("dev agent 配置未找到");

  const serverInstance = new WSServer({
    configStore, projectStore, providerStore, skillManager, agentManager: null as any, port: 19880,
  });

  const agentManager = new AgentManager({
    projectStore, configStore,
    onEvent: (sessionId, projectId, agentName, event) => {
      serverInstance.broadcast({
        type: "sdk:event", projectId, sessionId, agentName, event: event as any,
      });
    },
  });
  (serverInstance as any).opts.agentManager = agentManager;
  await serverInstance.start();
  server = serverInstance;

  ws = new WebSocket(`ws://127.0.0.1:${serverInstance.actualPort}`);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS 连接失败"));
    setTimeout(() => reject(new Error("WS 连接超时")), 5000);
  });

  const receivedEvents: any[] = [];
  let resolveFn: () => void;
  const done = new Promise<void>((resolve) => { resolveFn = resolve; });

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data as string);
    receivedEvents.push(data);
    if (data.type === "error") {
      console.log("[ERROR]", data.message);
    }
    if (data.type === "sdk:event" && data.event?.type === "agent_end") {
      resolveFn();
    }
  };

  ws.send(JSON.stringify({
    type: "agent:prompt",
    projectId: project.id,
    sessionId: "e2e-test-1",
    agentName: "dev",
    text: "回复 OK",
  }));

  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("LLM 超时")), 90000))]);

  const sdkEvents = receivedEvents.filter(e => e.type === "sdk:event");
  const eventTypes = sdkEvents.map(e => e.event.type);
  console.log("事件序列:", eventTypes.join(" → "));

  expect(sdkEvents.length).toBeGreaterThan(0);
  expect(eventTypes).toContain("agent_start");
  expect(eventTypes).toContain("agent_end");

  // 验证 user 消息只出现一次（不再有 ws-server 手动广播导致的重复）
  const userMsgStarts = sdkEvents.filter(e => e.event.type === "message_start" && e.event.message?.role === "user");
  expect(userMsgStarts.length).toBe(1);

  // 验证 assistant 消息只出现一次
  const assistantMsgEnds = sdkEvents.filter(e => e.event.type === "message_end" && e.event.message?.role === "assistant");
  expect(assistantMsgEnds.length).toBe(1);
  console.log("assistant 回复:", JSON.stringify(assistantMsgEnds[0].event.message).slice(0, 200));
}, 120000);
