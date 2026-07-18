import { test, describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";
import { BUILTIN_SKILLS_DIR } from "@hiagent/shared";
import type { AskParams } from "@hiagent/shared";
import { askRegistry } from "../src/ask-registry";

// mock createAgentSession 返回 fake AgentSession
// 测试不依赖真实 SDK 的 createAgentSession（避免子进程 / 网络 / 文件系统副作用）
const fakeUnsubscribe = mock(() => {});
const fakeModels = [
  { id: "test-model", provider: "anthropic", name: "Test Model", api: {}, baseUrl: "", reasoning: false },
  { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", api: {}, baseUrl: "", reasoning: false },
  { id: "gpt-4o", provider: "openai", name: "GPT-4o", api: {}, baseUrl: "", reasoning: false },
];
const fakeModelRegistry = {
  getAll: () => fakeModels,
  hasConfiguredAuth: () => true,
};
const fakeSession: Partial<AgentSession> = {
  prompt: mock(async () => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),
  setSessionName: mock(() => {}),
  setModel: mock(async () => {}),
  setThinkingLevel: mock(() => {}),
  subscribe: mock(() => fakeUnsubscribe),
  messages: [],
  model: { id: "test-model" } as any,
  isStreaming: false,
  pendingMessageCount: 0,
  isCompacting: false,
  clearQueue: mock(() => ({ steering: [], followUp: [] })),
  followUp: mock(async () => {}),
  steer: mock(async () => {}),
  reload: mock(async () => {}),
  modelRegistry: fakeModelRegistry as any,
};

const mockCreateAgentSession = mock(async () => ({
  session: fakeSession as AgentSession,
  extensionsResult: { extensions: [], errors: [], runtime: {} as any },
}));

// 每个测试前清理 mock 调用记录，避免相互干扰
beforeEach(() => {
  askRegistry.reset();
  mockCreateAgentSession.mockClear();
  (fakeSession.prompt as any).mockClear();
  (fakeSession.abort as any).mockClear();
  (fakeSession.setSessionName as any).mockClear();
  (fakeSession.setModel as any).mockClear();
  (fakeSession.setThinkingLevel as any).mockClear();
  (fakeSession.subscribe as any).mockClear();
  (fakeSession.dispose as any).mockClear();
  (fakeSession.clearQueue as any).mockClear();
  (fakeSession.followUp as any).mockClear();
  (fakeSession.steer as any).mockClear();
  (fakeSession as any).isStreaming = false;
  (fakeSession as any).pendingMessageCount = 0;
  (fakeSession as any).isCompacting = false;
  (fakeSession.reload as any).mockClear();
  fakeUnsubscribe.mockClear();
});

// 临时文件清理（防止 /tmp 堆积测试残留）
const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch {}
  }
});

function newProjectStore() {
  const tmpFile = `/tmp/hiagent-am-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  return new ProjectStore(tmpFile);
}

test("ensureStarted 创建 AgentSession 并订阅事件（不再设置 intercom 会话名）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const onEvent = mock(() => {});
  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent,
    createAgentSessionFn: mockCreateAgentSession,
  });
  const sdkSession = await am.ensureStarted(project.id, "dev", session.id);

  expect(sdkSession).toBe(fakeSession as AgentSession);
  expect(fakeSession.setSessionName).not.toHaveBeenCalled();
  expect(fakeSession.subscribe).toHaveBeenCalledTimes(1);
});

test("ensureStarted 无显式 tools 时使用默认工具集（含 grep/find/ls 与网络工具）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
  expect(mockCreateAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      tools: expect.arrayContaining([
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "web_search",
        "fetch_content",
        "get_search_content",
      ]),
    }),
  );
});

test("ensureStarted 使用 agent 显式配置的 tools", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: mock(async () => ({
      name: "dev",
      tools: ["read"],
    })),
  } as any;

  const am = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
  expect(mockCreateAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ tools: expect.arrayContaining(["read"]) }),
  );
});

test("ensureStarted 注入 memory customTools（绑定项目 store）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(mockCreateAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({ customTools: expect.any(Array) }),
  );
  const calls = (mockCreateAgentSession as any).mock.calls;
  const customTools = calls[calls.length - 1][0].customTools;
  expect(customTools.length).toBeGreaterThan(0);
  const names = customTools.map((t: any) => t.name);
  expect(names).toEqual(
    expect.arrayContaining(["memory_add", "memory_replace", "memory_remove", "memory_read"]),
  );
});

test("自动学习关闭（reviewEnabled=false）时不注册记忆工具", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
    memoryStore: { getConfig: async () => ({ reviewEnabled: false, memoryPolicyStyle: "full" as const }) },
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const calls = (mockCreateAgentSession as any).mock.calls;
  const names = calls[calls.length - 1][0].customTools.map((t: any) => t.name);
  expect(names).not.toContain("memory_add");
  expect(names).not.toContain("memory_replace");
  expect(names).not.toContain("memory_remove");
  expect(names).not.toContain("memory_read");
});

test("注入提示关闭（memoryPolicyStyle=none）时系统提示词不追加记忆快照", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
    memoryStore: { getConfig: async () => ({ reviewEnabled: true, memoryPolicyStyle: "none" as const }) },
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const calls = (mockCreateAgentSession as any).mock.calls;
  const loader = calls[calls.length - 1][0].resourceLoader;
  const prompt = await loader.getSystemPrompt();
  // 无快照追加：提示词以固定 env 段结尾（有记忆内容时也不能拼接）
  expect(prompt.trimEnd().endsWith("plain, user-facing language.")).toBe(true);
});

test("ensureStarted 复用已存在的 session（同 sessionId 不重复创建）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.ensureStarted(project.id, "dev", session.id);

  expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
});

test("ensureStarted 并发调用同 sessionId 只创建一次", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  let calls = 0;
  const slowCreate = mock(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 60));
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: slowCreate as any,
  });

  const [a, b] = await Promise.all([
    am.ensureStarted(project.id, "dev", session.id),
    am.ensureStarted(project.id, "dev", session.id),
  ]);

  expect(a).toBe(b);
  expect(calls).toBe(1);
  expect(slowCreate).toHaveBeenCalledTimes(1);
});

test("ensureStarted 创建失败时清理 starting 锁并允许重试", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  let calls = 0;
  const failingCreate = mock(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    throw new Error("创建失败");
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: failingCreate as any,
  });

  const results = await Promise.allSettled([
    am.ensureStarted(project.id, "dev", session.id),
    am.ensureStarted(project.id, "dev", session.id),
  ]);

  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
  expect(calls).toBe(1);

  // 失败后重新创建应能重试，而不是永远阻塞在失败的 Promise 上
  const recoveryAm = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  const sdkSession = await recoveryAm.ensureStarted(project.id, "dev", session.id);
  expect(sdkSession).toBe(fakeSession as AgentSession);
});

test("ensureStarted 创建过程中被 dispose 时清理资源并拒绝", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession.dispose as any).mockClear();
  fakeUnsubscribe.mockClear();

  const slowCreate = mock(async () => {
    await new Promise((r) => setTimeout(r, 60));
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: slowCreate as any,
  });

  const startPromise = am.ensureStarted(project.id, "dev", session.id);
  // 在创建完成前 dispose，模拟 session:delete 与 agent:prompt 并发
  await am.disposeSession(session.id);

  await expect(startPromise).rejects.toThrow("会话已清理");
  expect(fakeUnsubscribe).toHaveBeenCalledTimes(1);
  expect(fakeSession.dispose).toHaveBeenCalledTimes(1);
});

test("prompt — agent 空闲且无排队 → 直接 prompt（不带 streamingBehavior）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession as any).isStreaming = false;
  (fakeSession as any).pendingMessageCount = 0;

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "你好", { model: "anthropic/test-model" });

  expect(fakeSession.prompt).toHaveBeenCalledWith("你好");
});

test("prompt — agent 运行中 → followUp 排队", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession as any).isStreaming = true;
  (fakeSession as any).pendingMessageCount = 1;

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "排队消息", { model: "anthropic/test-model" });

  expect(fakeSession.prompt).toHaveBeenCalledWith("排队消息", { streamingBehavior: "followUp" });
});

test("prompt — 传入 model 时调用 setModel", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "你好", { model: "anthropic/test-model" });

  expect(fakeSession.setModel).toHaveBeenCalledTimes(1);
  const setModelArg = (fakeSession.setModel as any).mock.calls[0][0];
  expect(setModelArg.id).toBe("test-model");
  expect(setModelArg.provider).toBe("anthropic");
});

test("prompt — 传入 thinking 时映射为 SDK thinking level", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const cases: Array<[import("@hiagent/shared").ThinkingLevel, string]> = [
    ["disabled", "off"],
    ["medium", "medium"],
    ["high", "high"],
    ["max", "xhigh"],
  ];

  for (const [input, expected] of cases) {
    (fakeSession.setThinkingLevel as any).mockClear();
    await am.prompt(session.id, "你好", { model: "anthropic/test-model", thinking: input });
    expect(fakeSession.setThinkingLevel).toHaveBeenCalledWith(expected);
  }
});

test("abort 只中断当前运行，不管理队列（调用方自行处理队列）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.abort(session.id);

  // abort 清空队列（防 SDK auto-drain）后 abort，不恢复队列
  expect(fakeSession.clearQueue).toHaveBeenCalledTimes(1);
  expect(fakeSession.abort).toHaveBeenCalledTimes(1);
  expect(fakeSession.followUp).not.toHaveBeenCalled();
  expect(fakeSession.steer).not.toHaveBeenCalled();
});

test("promoteToSteer 把目标消息从 followUp 移到 steering，不打断当前 agent", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  (fakeSession.clearQueue as any).mockReturnValue({
    steering: ["已有引导"],
    followUp: ["目标", "剩余A", "剩余B"],
  });

  await am.promoteToSteer(session.id, "目标", ["剩余A", "剩余B"]);

  // 引导不应该 abort / prompt，只是把消息移到 steering 队列
  expect(fakeSession.abort).not.toHaveBeenCalled();
  expect(fakeSession.prompt).not.toHaveBeenCalled();
  // 原有 steering 保留，目标追加到 steering
  expect(fakeSession.steer).toHaveBeenCalledWith("已有引导");
  expect(fakeSession.steer).toHaveBeenCalledWith("目标");
  // 剩余消息按前端传入的 remainingTexts 恢复为 followUp
  expect(fakeSession.followUp).toHaveBeenCalledWith("剩余A");
  expect(fakeSession.followUp).toHaveBeenCalledWith("剩余B");
});

test("immediate 先清空队列再 abort，避免 abort 时 agent core 自动 drain 队列消息", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const order: string[] = [];
  (fakeSession.clearQueue as any).mockImplementation(() => {
    order.push("clearQueue");
    return { steering: [], followUp: ["排队A", "排队B"] };
  });
  (fakeSession.abort as any).mockImplementation(async () => {
    order.push("abort");
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  await am.immediate(session.id, "立即执行", ["剩余A", "剩余B"]);

  // 必须先清空队列再 abort，否则 agent core 会在 abort 过程中 drain 队列，
  // 导致排队消息被自动发送、队列状态乱掉。
  expect(order).toEqual(["clearQueue", "abort"]);
});

test("immediate — abort → clearQueue → 剩余重入 followUp → 目标消息以 steer 模式 prompt", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  await am.immediate(session.id, "立即执行", ["剩余A", "剩余B"]);

  expect(fakeSession.abort).toHaveBeenCalledTimes(1);
  expect(fakeSession.clearQueue).toHaveBeenCalledTimes(1);
  expect(fakeSession.followUp).toHaveBeenCalledWith("剩余A");
  expect(fakeSession.followUp).toHaveBeenCalledWith("剩余B");
  // 目标消息用 steer 模式，避免 abort 后仍 streaming 时报错
  expect(fakeSession.prompt).toHaveBeenCalledWith("立即执行", { streamingBehavior: "steer" });
});

test("immediate 快速连点会串行执行，不并发调用 prompt", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const promptCalls: { start: number; end: number }[] = [];
  (fakeSession.prompt as any).mockImplementation(async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    promptCalls.push({ start, end: Date.now() });
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const p1 = am.immediate(session.id, "第一条", []);
  const p2 = am.immediate(session.id, "第二条", []);
  await Promise.all([p1, p2]);

  expect(fakeSession.prompt).toHaveBeenCalledTimes(2);
  expect(promptCalls.length).toBe(2);
  // 第二次 prompt 的开始时间应不早于第一次的结束时间（允许 10ms 误差）
  expect(promptCalls[1].start).toBeGreaterThanOrEqual(promptCalls[0].end - 10);
});

test("clearSteeringQueue — 调用 session.clearQueue()", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  am.clearSteeringQueue(session.id);

  expect(fakeSession.clearQueue).toHaveBeenCalledTimes(1);
});

test("clearFollowUpQueue — 调用 session.clearQueue()", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  am.clearFollowUpQueue(session.id);

  expect(fakeSession.clearQueue).toHaveBeenCalledTimes(1);
});

test("clearSteeringQueue / clearFollowUpQueue — session 不存在时静默忽略", async () => {
  const am = new AgentManager({
    projectStore: newProjectStore(), configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  am.clearSteeringQueue("nonexistent");
  am.clearFollowUpQueue("nonexistent");
});

test("disposeSession 清理 session 和 unsubscribe", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.disposeSession(session.id);

  expect(fakeSession.dispose).toHaveBeenCalledTimes(1);
  expect(fakeUnsubscribe).toHaveBeenCalledTimes(1);
});

test("onEvent 把 SDK 事件转发给上层并携带 sessionId/projectId/agentName 上下文", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const received: Array<{ sessionId: string; projectId: string; agentName: string }> = [];
  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: (sid, pid, name) => received.push({ sessionId: sid, projectId: pid, agentName: name }),
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  // 拿到 subscribe 注册的回调，模拟 SDK 派发一个事件
  const subscribeCall = (fakeSession.subscribe as any).mock.calls[0];
  const listener: (e: AgentSessionEvent) => void = subscribeCall[0];
  listener({ type: "turn_start" } as AgentSessionEvent);

  expect(received).toHaveLength(1);
  expect(received[0]).toEqual({ sessionId: session.id, projectId: project.id, agentName: "dev" });
});

test("getMessages 在 session 不存在时返回空数组", () => {
  const projectStore = newProjectStore();
  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  expect(am.getMessages("不存在的-session")).toEqual([]);
});

test("prompt — 图片附件统一用 @路径引用", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession as any).model = { id: "test-model" };

  const imgPath = `/tmp/hiagent-img-${Date.now()}.png`;
  tmpFiles.push(imgPath);
  await import("node:fs/promises").then((fs) => fs.writeFile(imgPath, Buffer.from("fake-image")));

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "描述这张图", {
    model: "test-model",
    attachments: [{ kind: "image", path: imgPath, name: "示例.png", size: 0 }],
  });

  expect(fakeSession.prompt).toHaveBeenCalledTimes(1);
  const [calledText, calledOpts] = (fakeSession.prompt as any).mock.calls[0];
  expect(calledText).toContain("描述这张图");
  expect(calledText).toContain("Attachments:");
  expect(calledText).toMatch(/@hiagent-img-\d+\.png/);
  expect(calledOpts).toBeUndefined();
});

test("markAllDirty 后命中缓存时 deferred reload 一次并清脏", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);   // 首次创建（不在 dirty）
  (fakeSession.reload as any).mockClear();

  am.markAllDirty();                                        // 标脏
  await am.ensureStarted(project.id, "dev", session.id);   // 命中缓存 → reload 一次

  expect(fakeSession.reload).toHaveBeenCalledTimes(1);

  // 清脏后再次命中不再 reload
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakeSession.reload).toHaveBeenCalledTimes(1);
});

test("未标脏的会话命中缓存时不 reload", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  (fakeSession.reload as any).mockClear();

  await am.ensureStarted(project.id, "dev", session.id);   // 命中缓存但未标脏
  expect(fakeSession.reload).not.toHaveBeenCalled();
});

test("dirty 会话正在 streaming 时跳过 reload 且保留 dirty（idle 后补 reload）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  (fakeSession.reload as any).mockClear();
  (fakeSession as any).isStreaming = true;   // 模拟后台 agent 正在流式输出

  am.markAllDirty();
  await am.ensureStarted(project.id, "dev", session.id);   // 命中缓存但 streaming → 跳过
  expect(fakeSession.reload).not.toHaveBeenCalled();

  // idle 后再次命中 → dirty 仍保留，补一次 reload
  (fakeSession as any).isStreaming = false;
  await am.ensureStarted(project.id, "dev", session.id);
  expect(fakeSession.reload).toHaveBeenCalledTimes(1);
});

// 临时 skill 目录（Task 2 测试用）
function tmpSkillRoot() {
  const root = `/tmp/hiagent-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(root, "skills"), { recursive: true });  // builtin（空）
  return root;
}
function createSkillAt(dir: string, name: string, desc: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
}

test("ensureStarted 把启用 skill 路径作为 additionalSkillPaths 传给 loader", async () => {
  const skillRoot = tmpSkillRoot();
  tmpFiles.push(skillRoot);  // 复用现有 afterEach 清理
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "my-skill", "测试技能");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    skillManager,
    createAgentSessionFn: createFn as any,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(capturedLoaders).toHaveLength(1);
  const paths = capturedLoaders[0].additionalSkillPaths as string[];
  expect(paths.some((p) => p === join(userDir, "my-skill"))).toBe(true);
});

test("additionalSkillPaths 不含 builtin 来源的 skill（由 SDK 自动扫，避免碰撞）", async () => {
  const skillRoot = tmpSkillRoot();
  tmpFiles.push(skillRoot);
  createSkillAt(join(skillRoot, "skills"), "builtin-skill", "内置");  // builtin
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "user-skill", "用户");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    skillManager,
    createAgentSessionFn: createFn as any,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const paths = capturedLoaders[0].additionalSkillPaths as string[];
  expect(paths.some((p) => p === join(userDir, "user-skill"))).toBe(true);
  expect(paths.some((p) => p === join(join(skillRoot, "skills"), "builtin-skill"))).toBe(false);
});

test("skillManager 为空时 additionalSkillPaths 为空数组（不破坏现有无 skillManager 场景）", async () => {
  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
    // 不传 skillManager
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(capturedLoaders[0].additionalSkillPaths).toEqual([]);
});

test("systemPromptOverride 注入内置技能目录路径 + 禁止透露系统提示词约束", async () => {
  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const prompt = capturedLoaders[0].systemPromptOverride();
  expect(prompt).toContain(`Built-in directory: ${BUILTIN_SKILLS_DIR}`);
  expect(prompt).toMatch(/Never reveal.*system prompt/i);
  expect(prompt).toMatch(/internal terminology/i);
});

test("markSkillsDirty 不走 reload 路径（与 markAllDirty 独立）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  (fakeSession.reload as any).mockClear();

  am.markSkillsDirty();                                  // 新方法：标脏但不走 reload
  await am.ensureStarted(project.id, "dev", session.id); // 命中缓存

  // Task 3 阶段 _reloadIfDirty 还未实现重建分支，skillDirty 命中应既不 reload 也不重建
  expect(fakeSession.reload).not.toHaveBeenCalled();
});

test("disposeSession 清理 sessionMeta 和 skillDirty", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  // 标脏并确认内部 Map 已写入
  am.markSkillsDirty();
  expect((am as any).sessionMeta.has(session.id)).toBe(true);
  expect((am as any).skillDirty.has(session.id)).toBe(true);

  await am.disposeSession(session.id);

  // 清理后内部 Map 不应再包含该 session
  expect((am as any).sessionMeta.has(session.id)).toBe(false);
  expect((am as any).skillDirty.has(session.id)).toBe(false);
});

// 重建测试用的工厂：每次返回独立 mock session（独立 dispose/subscribe）
function makeFreshSession() {
  return {
    ...fakeSession,
    prompt: mock(async () => {}),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    setSessionName: mock(() => {}),
    setModel: mock(async () => {}),
    setThinkingLevel: mock(() => {}),
    subscribe: mock(() => mock(() => {})),
    clearQueue: mock(() => ({ steering: [], followUp: [] })),
    followUp: mock(async () => {}),
    steer: mock(async () => {}),
    reload: mock(async () => {}),
    messages: [],
    model: { id: "test-model" } as any,
    modelRegistry: fakeModelRegistry as any,
    isStreaming: false,
    pendingMessageCount: 0,
    isCompacting: false,
  } as any as AgentSession;
}

test("markSkillsDirty + idle → 重建会话（dispose 旧、创建新、返回新 session）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const created: AgentSession[] = [];
  const createFn = mock(async () => {
    const s = makeFreshSession();
    created.push(s);
    return { session: s, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  const first = await am.ensureStarted(project.id, "dev", session.id);
  expect(created).toHaveLength(1);

  am.markSkillsDirty();
  const second = await am.ensureStarted(project.id, "dev", session.id);  // idle → 重建

  expect(created).toHaveLength(2);                       // 重建调了一次 createFn
  expect(second).toBe(created[1]);                       // 返回新 session
  expect(second).not.toBe(first);                        // 与旧 session 不同
  expect((created[0].dispose as any)).toHaveBeenCalledTimes(1);  // 旧 session 被 dispose
  // 重建后 skillDirty 清除，再次命中不重建
  await am.ensureStarted(project.id, "dev", session.id);
  expect(created).toHaveLength(2);
});

test("markSkillsDirty 后 streaming 时跳过重建，保留 skillDirty（idle 后补重建）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const created: AgentSession[] = [];
  const createFn = mock(async () => {
    const s = makeFreshSession();
    created.push(s);
    return { session: s, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  const first = await am.ensureStarted(project.id, "dev", session.id);
  (first as any).isStreaming = true;  // 模拟生成中

  am.markSkillsDirty();
  const r = await am.ensureStarted(project.id, "dev", session.id);  // streaming → 跳过
  expect(created).toHaveLength(1);
  expect(r).toBe(first);  // 返回旧 session，未重建

  (first as any).isStreaming = false;  // idle
  const r2 = await am.ensureStarted(project.id, "dev", session.id);  // 补重建
  expect(created).toHaveLength(2);
  expect(r2).toBe(created[1]);
});

test("markAllDirty 仍走 reload 路径（不被重建逻辑影响）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const created: AgentSession[] = [];
  const createFn = mock(async () => {
    const s = makeFreshSession();
    created.push(s);
    return { session: s, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  const first = await am.ensureStarted(project.id, "dev", session.id);
  (first.reload as any).mockClear();

  am.markAllDirty();
  const r = await am.ensureStarted(project.id, "dev", session.id);  // dirty → reload
  expect(first.reload as any).toHaveBeenCalledTimes(1);
  expect(r).toBe(first);  // reload 不换 session
  expect(created).toHaveLength(1);  // 未重建
});

test("ensureStarted 把 ask_user_question 工具作为 customTools 传给 createFn", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const captured: any[] = [];
  const createFn = mock(async (opts: any) => {
    captured.push(opts);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: createFn as any });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(captured[0].customTools).toBeDefined();
  // customTools 现为 [...memoryCustomTools, makeAskTool(sessionId)]——ask 工具在末尾，
  // 用 find 按 name 查找，避免对 memory 工具数量/顺序的硬编码假设。
  const askTool = (captured[0].customTools as any[]).find((t: any) => t.name === "ask_user_question");
  expect(askTool).toBeDefined();
});

// ─── Task 6: delegate 关系网调起接线测试 ────────────────────────────────────
// askTo 非空 → customTools 含 delegate 工具且 systemPrompt 末尾含关系网段；
// askTo 为空 → 不注册 delegate 工具、不注入关系网段。
test("ensureStarted 在 askTo 非空时注册 delegate 工具并注入关系网提示词段", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const configs: Record<string, any> = {
    dev: { name: "dev", partners: { askTo: ["代码审查"], askFrom: [] }, triggerKeywords: [] },
    代码审查: { name: "代码审查", description: "评审改动", partners: { askTo: [], askFrom: ["dev"] }, triggerKeywords: ["review", "评审"] },
  };
  const configStore = { getAgent: mock(async (n: string) => configs[n] ?? null) } as any;

  const captured: any[] = [];
  const createFn = mock(async (opts: any) => {
    captured.push(opts);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const am = new AgentManager({ projectStore, configStore, onEvent: () => {}, createAgentSessionFn: createFn as any });
  await am.ensureStarted(project.id, "dev", session.id);

  const names = (captured[0].customTools as any[]).map((t: any) => t.name);
  expect(names).toContain("delegate");

  const prompt = captured[0].resourceLoader.systemPromptOverride();
  expect(prompt).toContain("delegate");
  expect(prompt).toContain("代码审查");
  expect(prompt).toContain("评审改动");
  expect(prompt).toContain("review、评审");
});

test("ensureStarted 在 askTo 为空时不注册 delegate 工具、不注入关系网段", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const configStore = {
    getAgent: mock(async () => ({ name: "dev", partners: { askTo: [], askFrom: [] }, triggerKeywords: [] })),
  } as any;

  const captured: any[] = [];
  const createFn = mock(async (opts: any) => {
    captured.push(opts);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const am = new AgentManager({ projectStore, configStore, onEvent: () => {}, createAgentSessionFn: createFn as any });
  await am.ensureStarted(project.id, "dev", session.id);

  const names = (captured[0].customTools as any[]).map((t: any) => t.name);
  expect(names).not.toContain("delegate");

  const prompt = captured[0].resourceLoader.systemPromptOverride();
  expect(prompt).not.toContain("delegate 工具");
});

// ─── Task 4: 中断清理（cancelAll）测试 ───────────────────────────────────────
// abort / immediate(_jumpQueue interrupt) / disposeSession 都应调
// askRegistry.cancelAll(sessionId)，把该 session 的 pending ask 以 cancelled 解决。
const askParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

test("abort 取消该 session 的 pending ask（同步 cancelAll）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.abort(session.id);
  expect((await p).cancelled).toBe(true);
});

test("immediate(_jumpQueue interrupt) 取消 pending ask", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.immediate(session.id, "立即执行", []);
  expect((await p).cancelled).toBe(true);
});

test("disposeSession 取消 pending ask", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });
  const am = new AgentManager({ projectStore, configStore: null as any, onEvent: () => {}, createAgentSessionFn: mockCreateAgentSession });
  await am.ensureStarted(project.id, "dev", session.id);

  const p = askRegistry.ask(session.id, "tc1", askParams, new AbortController().signal);
  await am.disposeSession(session.id);
  expect((await p).cancelled).toBe(true);
});

// ─── Task 8: reconcile 兜底接线测试 ─────────────────────────────────────────
// 覆盖 _createSession 里的重启兜底分支：当 session.messages 含「无 toolResult 的
// ask_user_question 调用」时，ensureStarted 应把 reconcileDanglingAsks 返回的
// reconciled 数组赋给 (session as any).agent.state.messages。
// 注：reconcileDanglingAsks 的纯函数行为由 ask-tool.test.ts 覆盖，这里只验证「接线赋值生效」。
test("ensureStarted 把 reconciled 数组赋给 session.agent.state.messages（有 dangling ask 时）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  // 构造一条 dangling ask 调用的历史：assistant 消息含 ask_user_question toolCall，无对应 toolResult。
  const danglingMessages: unknown[] = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-dangling",
          name: "ask_user_question",
          arguments: askParams,
        },
      ],
      model: "test-model",
      stopReason: "tool_use",
      timestamp: 1,
    },
  ];

  // 局部 fake session：messages 含 dangling ask；agent.state.messages 可写，用于断言赋值发生。
  // 仿照 makeFreshSession 但带 messages + agent.state.messages，不改全局 fakeSession。
  const localSession = {
    ...fakeSession,
    prompt: mock(async () => {}),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    setSessionName: mock(() => {}),
    setModel: mock(async () => {}),
    setThinkingLevel: mock(() => {}),
    subscribe: mock(() => mock(() => {})),
    clearQueue: mock(() => ({ steering: [], followUp: [] })),
    followUp: mock(async () => {}),
    steer: mock(async () => {}),
    reload: mock(async () => {}),
    messages: danglingMessages,
    model: { id: "test-model" } as any,
    modelRegistry: fakeModelRegistry as any,
    isStreaming: false,
    pendingMessageCount: 0,
    isCompacting: false,
    // reconcile 兜底的赋值目标：(session as any).agent.state.messages
    agent: { state: { messages: danglingMessages } },
  } as any as AgentSession;

  const createFn = mock(async () => ({
    session: localSession,
    extensionsResult: { extensions: [], errors: [], runtime: {} as any },
  }));

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  // 断言：reconcile 注入了一条 cancelled toolResult，
  // 且该 reconciled 数组被赋给 session.agent.state.messages。
  const assigned = (localSession as any).agent.state.messages as unknown[];
  expect(assigned.length).toBe(danglingMessages.length + 1);
  const last = assigned[assigned.length - 1] as Record<string, unknown>;
  expect(last.role).toBe("toolResult");
  expect(last.isError).toBe(false);
  expect(last.toolCallId).toBe("tc-dangling");
});
