import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";

// mock createAgentSession 返回 fake AgentSession
// 测试不依赖真实 SDK 的 createAgentSession（避免子进程 / 网络 / 文件系统副作用）
const fakeUnsubscribe = mock(() => {});
const fakeSession: Partial<AgentSession> = {
  prompt: mock(async () => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),
  setSessionName: mock(() => {}),
  subscribe: mock(() => fakeUnsubscribe),
  messages: [],
  state: { isStreaming: false } as any,
  hasQueuedMessages: mock(() => false),
  waitForIdle: mock(async () => {}),
  clearAllQueues: mock(() => {}),
  followUp: mock(() => {}),
  clearSteeringQueue: mock(() => {}),
  clearFollowUpQueue: mock(() => {}),
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
  (fakeSession.subscribe as any).mockClear();
  (fakeSession.dispose as any).mockClear();
  (fakeSession.hasQueuedMessages as any).mockClear();
  (fakeSession.waitForIdle as any).mockClear();
  (fakeSession.clearAllQueues as any).mockClear();
  (fakeSession.followUp as any).mockClear();
  (fakeSession.clearSteeringQueue as any).mockClear();
  (fakeSession.clearFollowUpQueue as any).mockClear();
  (fakeSession.state as any).isStreaming = false;
  (fakeSession.hasQueuedMessages as any).mockImplementation(() => false);
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
  // intercom 会话名格式：projectId-agentName-sessionId（对齐原 RPC --name 参数）
  expect(fakeSession.setSessionName).toHaveBeenCalledWith(`${project.id}-dev-${session.id}`);
  // subscribe 必须被调用一次（事件转发到 onEvent）
  expect(fakeSession.subscribe).toHaveBeenCalledTimes(1);
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

  // 第二次调用应命中 Map 缓存，不再走 createAgentSession
  expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
});

test("prompt — agent 空闲且无排队 → 直接 prompt（不带 streamingBehavior）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession.state as any).isStreaming = false;
  (fakeSession.hasQueuedMessages as any).mockReturnValue(false);

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "你好");

  expect(fakeSession.prompt).toHaveBeenCalledWith("你好");
});

test("prompt — agent 运行中 → followUp 排队", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  (fakeSession.state as any).isStreaming = true;
  (fakeSession.hasQueuedMessages as any).mockReturnValue(true);

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "排队消息");

  expect(fakeSession.prompt).toHaveBeenCalledWith("排队消息", { streamingBehavior: "followUp" });
});

test("abort 调用 session.abort", async () => {
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

  expect(fakeSession.abort).toHaveBeenCalledTimes(1);
});

test("promoteToSteer — abort → clearAllQueues → 剩余重入 followUp → prompt", async () => {
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
  expect(fakeSession.waitForIdle).toHaveBeenCalledTimes(1);
  expect(fakeSession.clearAllQueues).toHaveBeenCalledTimes(1);
  expect(fakeSession.followUp).toHaveBeenCalledWith({ role: "user", content: "剩余A", timestamp: expect.any(Number) });
  expect(fakeSession.followUp).toHaveBeenCalledWith({ role: "user", content: "剩余B", timestamp: expect.any(Number) });
  expect(fakeSession.prompt).toHaveBeenCalledWith("引导消息");
});

test("clearSteeringQueue — 调用 session.clearSteeringQueue()", async () => {
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

  expect(fakeSession.clearSteeringQueue).toHaveBeenCalledTimes(1);
});

test("clearFollowUpQueue — 调用 session.clearFollowUpQueue()", async () => {
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

  expect(fakeSession.clearFollowUpQueue).toHaveBeenCalledTimes(1);
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
