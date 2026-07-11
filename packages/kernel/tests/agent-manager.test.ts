import { test, describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";

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

test("ensureStarted 创建 AgentSession 并设置 intercom 会话名", async () => {
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
  expect(fakeSession.setSessionName).toHaveBeenCalledWith(`${project.id}-dev-${session.id}`);
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
    expect.objectContaining({ tools: ["read"] }),
  );
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

test("abort 先清空队列、再 abort、最后恢复 followUp，避免 abort 后继续发送队列消息", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession.clearQueue as any).mockReturnValue({ steering: [], followUp: ["排队A", "排队B"] });

  const am = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.abort(session.id);

  // 顺序：清空 → abort → 恢复 followUp
  expect(fakeSession.clearQueue).toHaveBeenCalledTimes(1);
  expect(fakeSession.abort).toHaveBeenCalledTimes(1);
  expect(fakeSession.followUp).toHaveBeenCalledWith("排队A");
  expect(fakeSession.followUp).toHaveBeenCalledWith("排队B");
  // steering 针对当前 run，abort 后不再恢复
  expect(fakeSession.steer).not.toHaveBeenCalled();
});

test("promoteToSteer — abort → clearQueue → 剩余重入 followUp → prompt", async () => {
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

  await am.promoteToSteer(session.id, "引导消息", ["剩余A", "剩余B"]);

  expect(fakeSession.abort).toHaveBeenCalledTimes(1);
  expect(fakeSession.clearQueue).toHaveBeenCalledTimes(1);
  // 剩余消息用 session.followUp 入队（SDK API: followUp(text)）
  expect(fakeSession.followUp).toHaveBeenCalledWith("剩余A");
  expect(fakeSession.followUp).toHaveBeenCalledWith("剩余B");
  // 目标消息直接 prompt
  expect(fakeSession.prompt).toHaveBeenCalledWith("引导消息");
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
