import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";

// mock createAgentSession 返回 fake AgentSession
// 测试不依赖真实 SDK 的 createAgentSession（避免子进程 / 网络 / 文件系统副作用）
const fakeUnsubscribe = mock(() => {});
const fakeModel = {
  id: "test-model",
  provider: "anthropic",
  name: "Test Model",
  api: {},
  baseUrl: "",
  reasoning: false,
};
const fakeModelRegistry = {
  getAll: () => [fakeModel],
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
  isStreaming: false,
  pendingMessageCount: 0,
  clearQueue: mock(() => ({ steering: [], followUp: [] })),
  followUp: mock(async () => {}),
  steer: mock(async () => {}),
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
  fakeSession.isStreaming = false;
  fakeSession.pendingMessageCount = 0;
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

test("prompt — agent 空闲且无排队 → 直接 prompt（不带 streamingBehavior）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  fakeSession.isStreaming = false;
  fakeSession.pendingMessageCount = 0;

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

  fakeSession.isStreaming = true;
  fakeSession.pendingMessageCount = 1;

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "排队消息");

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
  await am.prompt(session.id, "你好", { thinking: "disabled" });

  expect(fakeSession.setThinkingLevel).toHaveBeenCalledWith("off");

  (fakeSession.setThinkingLevel as any).mockClear();
  await am.prompt(session.id, "你好", { thinking: "high" });
  expect(fakeSession.setThinkingLevel).toHaveBeenCalledWith("high");
});

test("prompt — 图片附件读取为 base64 并传给 session.prompt", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  // 构造一个临时图片文件
  const imgPath = `/tmp/hiagent-img-${Date.now()}.png`;
  tmpFiles.push(imgPath);
  await import("node:fs/promises").then((fs) => fs.writeFile(imgPath, Buffer.from("fake-image")));

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  await am.prompt(session.id, "描述这张图", {
    attachments: [{ kind: "image", path: imgPath, name: "示例.png", size: 0 }],
  });

  expect(fakeSession.prompt).toHaveBeenCalledTimes(1);
  const [calledText, calledOpts] = (fakeSession.prompt as any).mock.calls[0];
  expect(calledText).toContain("描述这张图");
  expect(calledText).toContain("示例.png");
  expect(calledOpts.images).toHaveLength(1);
  expect(calledOpts.images[0].type).toBe("image");
  expect(calledOpts.images[0].mimeType).toBe("image/png");
  expect(calledOpts.images[0].data).toBe(Buffer.from("fake-image").toString("base64"));
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
