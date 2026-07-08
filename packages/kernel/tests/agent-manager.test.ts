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

test("prompt 调用 session.prompt，使用 steer 流式行为", async () => {
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
  await am.prompt(session.id, "你好");

  expect(fakeSession.prompt).toHaveBeenCalledWith("你好", { streamingBehavior: "steer" });
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
