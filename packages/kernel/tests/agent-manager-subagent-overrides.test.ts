// agent-manager 内置 subagent override 测试：
// 验证 resolveSpawnConfig 在 spawn 内置 subagent 时读取 subagent-overrides.json 中的 model/thinking
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// 捕获 subagent-runner 收到的 config（model/thinking 等）
const capturedConfigs: any[] = [];
mock.module("../src/subagent-runner", () => ({
  runSubagentAgent: mock(async (config: any, _task: string) => {
    capturedConfigs.push(config);
    return { text: "ok", isError: false };
  }),
  buildAgentDefinition: (c: any) => c,
}));

// mock subagent-store：在 resolveSpawnConfig 的 await import("./subagent-store") 中返回指定 override
mock.module("../src/subagent-store", () => ({
  loadSubagentOverrides: mock(async () => []),
  saveSubagentOverride: mock(async () => []),
  getSubagentOverride: mock(async (_file: string, type: string) => {
    if (type === "Plan") return { type: "Plan", model: "openai/gpt-4o", thinking: "max" };
    return undefined;
  }),
  ensureSubagentOverrides: mock(async () => {}),
}));

// mock pi-open-agents 的 loadAgents：避免真实文件读取
mock.module("pi-open-agents", () => ({
  loadAgents: mock(async () => ({ agents: [] })),
  runSubagent: mock(async () => ({ output: "ok", isError: false })),
}));

const fakeUnsubscribe = mock(() => {});
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
  modelRegistry: { getAll: () => [], hasConfiguredAuth: () => true } as any,
};

const mockCreateAgentSession = mock(async () => ({
  session: fakeSession as AgentSession,
  extensionsResult: { extensions: [], errors: [], runtime: {} as any },
}));

const tmpDir = `/tmp/hiagent-am-subagent-test-${Date.now()}`;
const HIAGENT_DIR = join(tmpDir, ".hiagent");

beforeEach(() => {
  mockCreateAgentSession.mockClear();
  capturedConfigs.length = 0;
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(HIAGENT_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function newProjectStore() {
  const projFile = join(HIAGENT_DIR, "projects.json");
  writeFileSync(projFile, JSON.stringify({ projects: [], sessions: [] }), "utf8");
  return new ProjectStore(projFile);
}

test("内置 subagent spawn 时读取 subagent-overrides.json 中的 model/thinking", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;

  const am = new AgentManager({
    projectStore, configStore, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  // 从 customTools 中提取 delegate 工具
  const calls = (mockCreateAgentSession as any).mock.calls;
  const customTools = calls[calls.length - 1][0].customTools as any[];
  const delegateTool = customTools.find((t: any) => t.name === "delegate");
  expect(delegateTool).toBeDefined();

  // 调用 delegate 调起内置 Plan 子智能体
  const result = await delegateTool.execute("tc-plan", { agent: "Plan", task: "设计个方案" });

  // spawn 不应报错
  expect(result.isError).toBe(false);

  // 验证 capturedConfigs 中包含 override 的 model/thinking
  expect(capturedConfigs.length).toBeGreaterThan(0);
  const planConfig = capturedConfigs.find((c: any) => c.name === "Plan");
  expect(planConfig).toBeDefined();
  expect(planConfig.model).toBe("openai/gpt-4o");
  expect(planConfig.thinking).toBe("max");
});
