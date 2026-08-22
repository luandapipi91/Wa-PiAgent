// agent-manager 内置 subagent override 测试：
// 验证 resolveSpawnConfig 在 spawn 内置 subagent 时读取 subagent-overrides.json 中的 model/thinking。
//
// RPC 迁移后的触发链路：
//   getBridgeSession(sessionId).handleTool("delegate", ...)   （bridge 扩展回调入口）
//   → delegateTool.execute → spawnFn → resolveSpawnConfig（读 override 文件）
//   → runSubagentAgent(config, task, cwd)                     （此处 mock 捕获 config）
//
// mock 策略说明（bun 的 mock.module 进程级全局生效且 mock.restore() 无法撤销）：
// - subagent-runner：必须 mock（捕获 config 的唯一接缝；不真正 spawn 子进程）。
//   排序靠后的 subagent-runner.test.ts 用 cache-bust 动态 import（"../src/subagent-runner.ts?real"）
//   绕过本 mock 拿真实实现，互不干扰。
// - subagent-store：不 mock（避免污染 subagent-store.test.ts / subagent-info.test.ts），
//   改为备份 → 写入 → 恢复真实 SUBAGENT_OVERRIDES_FILE。
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { FakeSessionClient, fakeClientFactory } from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { getBridgeSession } from "../src/bridge-registry";
import { WA_PI_DIR, SUBAGENT_OVERRIDES_FILE } from "@wa-pi/shared";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// 捕获 subagent-runner 收到的 config（model/thinking 等）；不真正 spawn 子进程
const capturedConfigs: any[] = [];
mock.module("../src/subagent-runner", () => ({
  runSubagentAgent: mock(async (config: any, _task: string) => {
    capturedConfigs.push(config);
    return { text: "ok", isError: false };
  }),
}));

const tmpFiles: string[] = [];
const managers: AgentManager[] = [];
// 真实 overrides 文件的备份（null = 原本不存在，测后删除）
let overridesBackup: string | null = null;

beforeEach(() => {
  capturedConfigs.length = 0;
  overridesBackup = existsSync(SUBAGENT_OVERRIDES_FILE)
    ? readFileSync(SUBAGENT_OVERRIDES_FILE, "utf8")
    : null;
});

afterEach(async () => {
  // 恢复真实 overrides 文件
  try {
    if (overridesBackup === null) rmSync(SUBAGENT_OVERRIDES_FILE, { force: true });
    else writeFileSync(SUBAGENT_OVERRIDES_FILE, overridesBackup, "utf8");
  } catch {}
  overridesBackup = null;
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch {}
  }
});

function newProjectStore() {
  const tmpFile = `/tmp/wa-pi-am-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  tmpFiles.push(tmpFile);
  return new ProjectStore(tmpFile);
}

test("内置 subagent spawn 时读取 subagent-overrides.json 中的 model/thinking", async () => {
  // 写入真实 override：Plan → openai/gpt-4o + max
  writeFileSync(
    SUBAGENT_OVERRIDES_FILE,
    JSON.stringify({ overrides: [{ type: "Plan", model: "openai/gpt-4o", thinking: "max" }] }),
    "utf8",
  );

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore, configStore, onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);

  // 经 bridge 上下文调用 delegate 调起内置 Plan 子智能体
  const ctx = getBridgeSession(session.id);
  expect(ctx).toBeDefined();
  const result = await ctx!.handleTool(
    "delegate", "tc-plan", { agent: "Plan", task: "设计个方案" }, new AbortController().signal,
  );

  // spawn 不应报错
  expect(result.content[0].text).toBe("ok");

  // 验证 capturedConfigs 中包含 override 的 model/thinking
  expect(capturedConfigs.length).toBeGreaterThan(0);
  const planConfig = capturedConfigs.find((c: any) => c.name === "Plan");
  expect(planConfig).toBeDefined();
  expect(planConfig.model).toBe("openai/gpt-4o");
  expect(planConfig.thinking).toBe("max");

  // 清理本次会话的系统提示词临时文件
  try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`), { force: true }); } catch {}
});

test("内置 subagent override model 无效时降级为 null（不传 --model）", async () => {
  // 写入 override：Explore → "test-model"（明显无效的模型，不含 /）
  writeFileSync(
    SUBAGENT_OVERRIDES_FILE,
    JSON.stringify({ overrides: [{ type: "Explore", model: "test-model", thinking: "high" }] }),
    "utf8",
  );

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore, configStore, onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);

  const ctx = getBridgeSession(session.id);
  expect(ctx).toBeDefined();
  const result = await ctx!.handleTool(
    "delegate", "tc-explore", { agent: "Explore", task: "搜索代码" }, new AbortController().signal,
  );

  // spawn 不应因模型无效而报错
  expect(result.content[0].text).toBe("ok");

  // 验证 capturedConfigs 中 model 为 null（无效模型被降级）
  expect(capturedConfigs.length).toBeGreaterThan(0);
  const exploreConfig = capturedConfigs.find((c: any) => c.name === "Explore");
  expect(exploreConfig).toBeDefined();
  expect(exploreConfig.model).toBeNull();  // 无效模型 → null
  expect(exploreConfig.thinking).toBe("high");  // thinking 照常透传

  // 清理
  try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`), { force: true }); } catch {}
});

test("子智能体跟随主模型：无 override 时用主会话 currentModel", async () => {
  // 不写 override 文件（备份在 afterEach 恢复；确保为空状态）
  try { rmSync(SUBAGENT_OVERRIDES_FILE, { force: true }); } catch {}

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore, configStore, onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);

  // 模拟主会话已用模型发过消息（prompt 时记录到 handle.currentModel）
  (am as any).sessions.get(session.id).currentModel = "opencode-zen-go/deepseek-v4-flash";

  const ctx = getBridgeSession(session.id);
  const result = await ctx!.handleTool(
    "delegate", "tc-plan2", { agent: "Plan", task: "设计个方案" }, new AbortController().signal,
  );
  expect(result.content[0].text).toBe("ok");

  const planConfig = capturedConfigs.find((c: any) => c.name === "Plan");
  expect(planConfig).toBeDefined();
  // 无 override → 跟随主会话当前模型
  expect(planConfig.model).toBe("opencode-zen-go/deepseek-v4-flash");

  try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`), { force: true }); } catch {}
});

test("只读内置子智能体（Explore/Plan）spawn 配置 tools 为只读白名单，不含 browser_*", async () => {
  // 不写 override 文件（备份在 afterEach 恢复；确保干净状态）
  try { rmSync(SUBAGENT_OVERRIDES_FILE, { force: true }); } catch {}

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({
    projectId: project.id, primaryAgent: "dev", title: "测试",
  });

  const configStore = {
    getAgent: mock(async () => ({ displayName: "dev", partners: { askTo: [] } })),
  } as any;

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore, configStore, onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);

  const ctx = getBridgeSession(session.id);
  expect(ctx).toBeDefined();

  // Explore / Plan 均为只读内置子智能体：spawn 配置 tools 应为只读白名单（不含 browser_*）
  for (const agent of ["Explore", "Plan"]) {
    const result = await ctx!.handleTool(
      "delegate", `tc-${agent}-ro`, { agent, task: "搜索代码" }, new AbortController().signal,
    );
    expect(result.content[0].text).toBe("ok");

    const cfg = capturedConfigs.find((c: any) => c.name === agent);
    expect(cfg).toBeDefined();
    expect(cfg.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
    for (const t of cfg.tools ?? []) {
      expect(t).not.toMatch(/^browser_/);
    }
  }

  try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${session.id}.md`), { force: true }); } catch {}
});
