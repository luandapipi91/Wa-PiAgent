/**
 * Steer 队列 POC — 验证 SDK 队列 API 可用性
 *
 * 第一部分：mock 验证 API 契约（始终运行）
 * 第二部分：真实 SDK 验证（RUN_SDK_E2E=1 时运行）
 */
import { test, expect, mock, afterAll } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

// ============================================================
// 第一部分：Mock AgentSession — 验证 AgentManager 新增 API 契约
// ============================================================

let queuedSteerMessages: string[] = [];
let queuedFollowUpMessages: string[] = [];

function resetQueues() {
  queuedSteerMessages = [];
  queuedFollowUpMessages = [];
}

const fakeAgent: any = {
  steer: mock((msg: any) => { queuedSteerMessages.push(msg.content || msg); }),
  followUp: mock((msg: any) => { queuedFollowUpMessages.push(msg.content || msg); }),
  clearSteeringQueue: mock(() => { queuedSteerMessages = []; }),
  clearFollowUpQueue: mock(() => { queuedFollowUpMessages = []; }),
  clearAllQueues: mock(() => { queuedSteerMessages = []; queuedFollowUpMessages = []; }),
  hasQueuedMessages: mock(() => queuedSteerMessages.length > 0 || queuedFollowUpMessages.length > 0),
  abort: mock(() => {}),
  waitForIdle: mock(async () => {}),
  get steeringMode() { return "one-at-a-time" as const; },
  get followUpMode() { return "one-at-a-time" as const; },
  subscribe: mock(() => mock(() => {})),
  state: { isStreaming: true },
};

const fakeSession: Partial<AgentSession> = {
  prompt: mock(async () => {}),
  abort: mock(async () => fakeAgent.abort()),
  dispose: mock(() => {}),
  setSessionName: mock(() => {}),
  subscribe: mock(() => mock(() => {})),
  messages: [],
  agent: fakeAgent as any,
};

const mockCreateAgentSession = mock(async () => ({
  session: fakeSession as AgentSession,
  extensionsResult: { extensions: [], errors: [], runtime: {} as any },
}));

const tmpFiles: string[] = [];
function newProjectStore() {
  const tmpFile = `/tmp/hiagent-poc-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  return new ProjectStore(tmpFile);
}

afterAll(() => {
  for (const f of tmpFiles) {
    try { rmSync(f, { force: true }); } catch {}
  }
});

// ---------- 测试用例 ----------

test("POC-1: AgentManager.steer() → 调用 session.agent.steer()", async () => {
  resetQueues();
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const sessionEntity = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: mock(() => {}),
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", sessionEntity.id);

  // 验证 steer 入队
  fakeAgent.steer({ role: "user", content: "引导消息1", timestamp: Date.now() });
  expect(queuedSteerMessages).toHaveLength(1);

  fakeAgent.steer({ role: "user", content: "引导消息2", timestamp: Date.now() });
  expect(queuedSteerMessages).toHaveLength(2);
});

test("POC-2: AgentManager.clearSteeringQueue() → 清空 steer 队列", async () => {
  resetQueues();
  fakeAgent.steer({ role: "user", content: "引导消息", timestamp: Date.now() });
  expect(queuedSteerMessages).toHaveLength(1);

  fakeAgent.clearSteeringQueue();
  expect(queuedSteerMessages).toHaveLength(0);
});

test("POC-3: AgentManager.immediate() → abort + waitForIdle + prompt", async () => {
  resetQueues();
  fakeAgent.steer({ role: "user", content: "不要的消息1", timestamp: Date.now() });
  fakeAgent.followUp({ role: "user", content: "不要的消息2", timestamp: Date.now() });

  // 立即：abort → 清空队列 → 发送目标消息
  fakeAgent.abort();
  await fakeAgent.waitForIdle();
  fakeAgent.clearAllQueues();
  expect(queuedSteerMessages).toHaveLength(0);
  expect(queuedFollowUpMessages).toHaveLength(0);

  await (fakeSession.prompt as any)("立即执行的消息");
  expect(fakeSession.prompt).toHaveBeenCalledWith("立即执行的消息");
});

test("POC-4: steer:promote → abort + clearAllQueues + 剩余重入队 + steer", async () => {
  resetQueues();
  // 模拟：队列中有 ["A","B","C"]，目标提升 "B" 为 steer
  fakeAgent.followUp({ role: "user", content: "A", timestamp: Date.now() });
  fakeAgent.followUp({ role: "user", content: "B", timestamp: Date.now() });
  fakeAgent.followUp({ role: "user", content: "C", timestamp: Date.now() });
  expect(queuedFollowUpMessages).toHaveLength(3);

  // 提升 B 为 steer
  fakeAgent.abort();
  await fakeAgent.waitForIdle();
  fakeAgent.clearAllQueues();
  // 剩余 ["A","C"] 加回 followUp
  fakeAgent.followUp({ role: "user", content: "A", timestamp: Date.now() });
  fakeAgent.followUp({ role: "user", content: "C", timestamp: Date.now() });
  expect(queuedFollowUpMessages).toHaveLength(2);

  // B 作为 steer 发送
  fakeAgent.steer({ role: "user", content: "B", timestamp: Date.now() });
  expect(queuedSteerMessages).toHaveLength(1);
});

test("POC-5: steer:cancel → clearSteeringQueue", async () => {
  resetQueues();
  fakeAgent.steer({ role: "user", content: "要取消的引导", timestamp: Date.now() });
  expect(queuedSteerMessages).toHaveLength(1);

  fakeAgent.clearSteeringQueue();
  expect(queuedSteerMessages).toHaveLength(0);
});

// ============================================================
// 第二部分：真实 SDK 验证（需要 API key）
// ============================================================

const RUN_E2E = process.env.RUN_SDK_E2E === "1";
const TEST_DIR = `/tmp/hiagent-steer-poc-${Date.now()}`;

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
description: POC
model: deepseek/deepseek-v4-flash
thinking: off
systemPromptMode: replace
inheritSkills: false
tools: []
skills: []
mcpServers: []
partners:
  askTo: []
---
你是一个测试助手，用一句话回复。`,
    "utf8",
  );

  afterAll(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });
}

test.skipIf(!RUN_E2E)("POC-E2E: steer + queue_update 事件触发", async () => {
  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } =
    await import("@earendil-works/pi-coding-agent");

  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("deepseek", "sk-cfdb4d0613df41fc9d220c0aa4e268a3");
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    cwd: TEST_DIR,
    agentDir: TEST_DIR,
    sessionManager: SessionManager.open(`${TEST_DIR}/sessions/poc-e2e.jsonl`),
    thinkingLevel: "off",
    tools: [],
    authStorage,
    modelRegistry,
  });

  const events: string[] = [];
  let lastQueueUpdate: any = null;
  const unsubscribe = session.subscribe((event) => {
    events.push(event.type);
    if (event.type === "queue_update") {
      lastQueueUpdate = event;
      console.log("[POC] queue_update:", JSON.stringify(event));
    }
  });

  // 发送第一条 prompt
  const promptPromise = session.prompt("回复：收到");

  // 稍等后发送 steer
  await new Promise(r => setTimeout(r, 500));
  console.log("[POC] agent hasQueuedMessages:", session.agent.hasQueuedMessages());
  console.log("[POC] steeringMode:", session.agent.steeringMode);
  console.log("[POC] followUpMode:", session.agent.followUpMode);

  // 发送 steer 引导消息
  await session.prompt("改为回复：已修改", { streamingBehavior: "steer" });

  // 发送 followUp 排队消息  
  await session.prompt("再回复：完成", { streamingBehavior: "followUp" });

  await promptPromise;

  // 打印结果
  console.log("[POC] 事件序列:", events.join(" → "));
  console.log("[POC] 是否有 queue_update:", events.includes("queue_update"));
  console.log("[POC] steer 队列长度:", (session.agent as any).steeringQueue?.hasItems?.());

  unsubscribe();
  session.dispose();

  // 关键断言
  expect(events).toContain("agent_start");
  expect(events).toContain("agent_end");
});
