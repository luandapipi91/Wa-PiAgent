// 子代理 MCP 工具可见性测试：
// 验证 delegate 派发的子代理进程能拿到 MCP 工具——两个必要条件：
//   1. spawn 的 -e 扩展集包含 pi-mcp-adapter（MCP 工具由 adapter 在子进程内注册，
//      子代理是独立 pi 进程，不随主会话继承）；
//   2. 工具白名单并入 MCP direct 工具名（内置只读类型另放行 "mcp" 聚合工具，
//      覆盖 directTools=false 走聚合模式的 mcp.json 配置）。
//
// 触发链路（与 agent-manager-subagent-overrides.test.ts 相同）：
//   getBridgeSession(sessionId).handleTool("delegate", ...)
//   → delegateTool.execute → spawnFn → resolveSpawnConfig
//   → runSubagentAgent(config, task, cwd, opts)   （此处 mock 捕获 config + opts.extensionPaths）
//
// mock 策略：subagent-runner 必须 mock（捕获参数接缝，不真正 spawn）；
// mcp-connector 必须 mock（resolveMcpDirectToolNames 会真实连接 MCP 服务器列工具）。
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { McpStore } from "../src/mcp-store";
import { mcpAdapterExtensionPath } from "../src/extensions";
import {
  type FakeSessionClient,
  fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { getBridgeSession } from "../src/bridge-registry";
import { WA_PI_DIR, GENERATED_DIR } from "@wa-pi/shared";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mocks ────────────────────────────────────────────────────────────────────
const capturedConfigs: any[] = [];
const capturedSpawnOpts: any[] = [];
mock.module("../src/subagent-runner", () => ({
  runSubagentAgent: mock(
    async (config: any, _task: string, _cwd: string, opts: any) => {
      capturedConfigs.push(config);
      capturedSpawnOpts.push(opts);
      return { text: "ok", isError: false };
    },
  ),
}));

// MCP direct 工具名固定返回（真实实现会连接 MCP 服务器，测试不连网）
mock.module("../src/mcp-connector", () => ({
  testConnection: mock(async () => ({
    ok: false,
    latencyMs: 0,
    error: "mocked",
  })),
  listTools: mock(async () => []),
  resolveMcpDirectToolNames: mock(async () => [
    "dbx_project_list",
    "dbx_artifact_get",
  ]),
}));

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];
const managers: AgentManager[] = [];

beforeEach(() => {
  capturedConfigs.length = 0;
  capturedSpawnOpts.length = 0;
});

afterEach(async () => {
  for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 临时文件清理失败可忽略 */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败可忽略 */
    }
  }
});

function newProjectStore() {
  const tmpFile = join(
    tmpdir(),
    `wa-pi-am-subagent-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tmpFiles.push(tmpFile);
  return new ProjectStore(tmpFile);
}

async function setupManager(configStore: any) {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({
    name: "测试",
    cwd: "/tmp",
  });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "测试",
  });
  const waPiDir = mkdtempSync(join(tmpdir(), "wa-pi-mcp-store-"));
  tmpDirs.push(waPiDir);
  const mcpStore = new McpStore({ waPiDir, projectStore });

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
    mcpStore,
  });
  managers.push(am);
  await am.ensureStarted(project.id, "dev", session.id);
  return session;
}

async function delegateTo(sessionId: string, agent: string) {
  const ctx = getBridgeSession(sessionId);
  expect(ctx).toBeDefined();
  const result = await ctx!.handleTool(
    "delegate",
    `tc-${agent}`,
    { agent, task: "hi" },
    new AbortController().signal,
  );
  expect(result.content[0].text).toBe("ok");
  // 清理本次会话的系统提示词临时文件
  try {
    rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${sessionId}.md`), {
      force: true,
    });
  } catch {
    /* 临时提示词清理失败可忽略 */
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("mcpAdapterExtensionPath: 解析到已安装的 pi-mcp-adapter 入口且文件存在", () => {
  const p = mcpAdapterExtensionPath();
  expect(p).not.toBeNull();
  expect(existsSync(p!)).toBe(true);
  expect(p!).toContain("pi-mcp-adapter");
});

test("内置只读子代理（Explore）：白名单并入 MCP direct 工具名与 mcp 聚合工具，-e 含 pi-mcp-adapter", async () => {
  const session = await setupManager({
    getAgent: mock(async () => ({
      displayName: "dev",
      partners: { askTo: [] },
    })),
  } as any);

  await delegateTo(session.id, "Explore");

  expect(capturedConfigs.length).toBeGreaterThan(0);
  const explore = capturedConfigs.find((c: any) => c.name === "Explore");
  expect(explore).toBeDefined();
  // 5 个只读基础工具 ∪ MCP direct 工具名 ∪ mcp 聚合工具
  for (const t of [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "dbx_project_list",
    "dbx_artifact_get",
    "mcp",
  ]) {
    expect(explore.tools).toContain(t);
  }
  // -e 扩展集包含 pi-mcp-adapter 入口（MCP 工具在子进程内注册的前提）
  const adapterPath = mcpAdapterExtensionPath();
  expect(adapterPath).not.toBeNull();
  const extPaths: string[] = capturedSpawnOpts[0]?.extensionPaths ?? [];
  expect(extPaths).toContain(adapterPath!);
  // provider-extension 仍在（--model 依赖它解析自定义 provider）；测试环境可能未
  // 生成该文件（首启才生成），存在时才断言透传
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  if (existsSync(providerExt)) {
    expect(extPaths).toContain(providerExt);
  }
});

test("内置非只读子代理（general-purpose）：tools 保持空数组（不传 --tools 全量放行），-e 含 pi-mcp-adapter", async () => {
  const session = await setupManager({
    getAgent: mock(async () => ({
      displayName: "dev",
      partners: { askTo: [] },
    })),
  } as any);

  await delegateTo(session.id, "general-purpose");

  const gp = capturedConfigs.find((c: any) => c.name === "general-purpose");
  expect(gp).toBeDefined();
  // 空数组 = subagent-runner 不传 --tools，pi 全量放行进程内已注册工具
  //（含 adapter 注册的 MCP direct + mcp），无需白名单合并
  expect(gp.tools).toEqual([]);
  const adapterPath = mcpAdapterExtensionPath();
  const extPaths: string[] = capturedSpawnOpts[0]?.extensionPaths ?? [];
  expect(extPaths).toContain(adapterPath!);
});

test("命名智能体：严格按勾选的 tools 放行（原始设计：勾选即放行，不自动并 MCP 工具名）", async () => {
  const session = await setupManager({
    getAgent: mock(async () => ({
      displayName: "研究员",
      tools: ["read", "grep"],
      skills: [],
      systemPromptBody: "做研究",
      partners: { askTo: [{ name: "研究员", description: "研究" }] },
    })),
  } as any);

  await delegateTo(session.id, "研究员");

  const named = capturedConfigs.find((c: any) => c.name === "研究员");
  expect(named).toBeDefined();
  // 原始设计：命名智能体按「智能体设置-工具」勾选集透传，不自动并入 MCP direct
  // 工具名（需要 MCP 工具可显式勾选，或不勾选走全放行）
  expect(named.tools).toEqual(["read", "grep"]);
});
