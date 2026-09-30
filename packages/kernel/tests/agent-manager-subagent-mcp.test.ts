// 子代理 MCP 工具可见性测试：
// 验证 delegate 派发的子代理进程能拿到 MCP 工具——两个必要条件：
//   1. 子进程的 pi 自行加载内置 MCP 扩展（builtin:mcp，默认加载）：MCP 工具在子进程内
//      注册，不随主会话继承，故 spawn 的 -e 扩展集不得再注入已移除的 pi-mcp-adapter；
//   2. 工具白名单并入 mcp-admin 实时枚举出的 MCP 工具名（`mcp__<server>__<tool>`，规格
//      F4；只有 exposure=direct 的服务器工具「可声明」——旧的 "mcp" 聚合工具随 adapter
//      一起退场，codemode/deferred 工具经 codemode/tool_search 到达，不进白名单）。
//
// 触发链路（与 agent-manager-subagent-overrides.test.ts 相同）：
//   getBridgeSession(sessionId).handleTool("delegate", ...)
//   → delegateTool.execute → spawnFn → resolveSpawnConfig
//   → runSubagentAgent(config, task, cwd, opts)   （此处 mock 捕获 config + opts.extensionPaths）
//
// mock 策略：subagent-runner 必须 mock（捕获参数接缝，不真正 spawn）；
// MCP 枚举注入 fake mcpAdmin（真实 McpAdmin 会 spawn `pi mcp list` 真连服务器，测试不连网）。
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import type { McpServerReport } from "../src/mcp-admin";
import {
  makeFakeMcpAdmin,
  type FakeMcpAdmin,
} from "./helpers/fake-mcp-admin";
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

/** mcp-admin 枚举结果：只有 connected + exposure=direct 的工具有资格进白名单 */
const MCP_SERVERS: McpServerReport[] = [
  {
    name: "dbx",
    scope: "global",
    enabled: true,
    exposure: "direct",
    state: "connected",
    tools: ["query", "list"],
  },
  {
    // 非 direct 曝光：工具经 codemode 到达，不并入白名单（规格 §6）
    name: "ologs",
    scope: "global",
    enabled: true,
    exposure: "codemode",
    state: "connected",
    tools: ["get_profile"],
  },
  {
    // 未连上：工具名未知，不并入白名单
    name: "flaky",
    scope: "global",
    enabled: true,
    exposure: "direct",
    state: "failed",
    tools: [],
  },
];

const tmpFiles: string[] = [];
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
});

function newProjectStore() {
  const tmpFile = join(
    tmpdir(),
    `wa-pi-am-subagent-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tmpFiles.push(tmpFile);
  return new ProjectStore(tmpFile);
}

async function setupManager(
  configStore: any,
  mcpAdmin: FakeMcpAdmin = makeFakeMcpAdmin([...MCP_SERVERS]),
  overrides: { cwd?: string; mcpAdminFor?: (cwd: string) => FakeMcpAdmin } = {},
) {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({
    name: "测试",
    cwd: overrides.cwd ?? "/tmp",
  });
  const session = await projectStore.createSession({
    projectId: project.id,
    primaryAgent: "dev",
    title: "测试",
  });

  const fakes: FakeSessionClient[] = [];
  const am = new AgentManager({
    projectStore,
    configStore,
    onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
    browserManager: NOOP_BROWSER_MANAGER,
    // 项目作用域用例：按 cwd 拿不同枚举结果；其余用例用固定 fake
    ...(overrides.mcpAdminFor ? { mcpAdminFor: overrides.mcpAdminFor } : { mcpAdmin }),
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

test("内置只读子代理（Explore）：白名单并入枚举出的 mcp__srv__tool，不含旧的 mcp 聚合名，-e 不含 pi-mcp-adapter", async () => {
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
  // 5 个只读基础工具 ∪ 枚举出的 MCP 工具名（direct 服务器的每个工具一个名字）
  for (const t of [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "mcp__dbx__query",
    "mcp__dbx__list",
  ]) {
    expect(explore.tools).toContain(t);
  }
  // 旧聚合名已随 adapter 退场：不再放行
  expect(explore.tools).not.toContain("mcp");
  // 非 direct 曝光（codemode）与未连上的服务器，工具名都不进白名单
  expect(explore.tools).not.toContain("mcp__ologs__get_profile");
  expect(explore.tools.some((t: string) => t.startsWith("mcp__flaky__"))).toBe(
    false,
  );
  // -e 扩展集不得再注入 pi-mcp-adapter（MCP 由子进程内的 pi 内置扩展自行加载）
  const extPaths: string[] = capturedSpawnOpts[0]?.extensionPaths ?? [];
  expect(extPaths.some((p) => p.includes("pi-mcp-adapter"))).toBe(false);
  // provider-extension 仍在（--model 依赖它解析自定义 provider）；测试环境可能未
  // 生成该文件（首启才生成），存在时才断言透传
  const providerExt = join(GENERATED_DIR, "provider-extension.ts");
  if (existsSync(providerExt)) {
    expect(extPaths).toContain(providerExt);
  }
});

test("内置只读子代理：MCP 枚举失败（list 抛错）不阻断 delegate，白名单退回 5 个基础工具", async () => {
  const broken = makeFakeMcpAdmin();
  broken.list = async () => {
    throw new Error("pi 起不来");
  };
  const session = await setupManager(
    {
      getAgent: mock(async () => ({
        displayName: "dev",
        partners: { askTo: [] },
      })),
    } as any,
    broken,
  );

  await delegateTo(session.id, "Explore");

  const explore = capturedConfigs.find((c: any) => c.name === "Explore");
  expect(explore).toBeDefined();
  expect(explore.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
});

test("内置只读子代理（Explore）：按会话/项目 cwd 枚举，受信项目 .pi/mcp.json 的工具可进白名单", async () => {
  const projectCwd = mkdtempSync(join(tmpdir(), "wa-pi-mcp-subagent-proj-"));
  const projectAdmin = makeFakeMcpAdmin([
    {
      name: "proj",
      scope: "project",
      enabled: true,
      exposure: "direct",
      state: "connected",
      tools: ["proj_tool"],
    },
  ]);
  const seenCwds: string[] = [];
  const session = await setupManager(
    {
      getAgent: mock(async () => ({
        displayName: "dev",
        partners: { askTo: [] },
      })),
    } as any,
    makeFakeMcpAdmin(),
    {
      cwd: projectCwd,
      mcpAdminFor: (cwd) => {
        seenCwds.push(cwd);
        return projectAdmin;
      },
    },
  );

  await delegateTo(session.id, "Explore");

  // 子代理是独立 pi 进程，项目级配置随 cwd 生效：必须用会话/项目 cwd 枚举才拿得到
  expect(seenCwds).toContain(projectCwd);
  const explore = capturedConfigs.find((c: any) => c.name === "Explore");
  expect(explore).toBeDefined();
  expect(explore.tools).toContain("mcp__proj__proj_tool");
});

test("内置非只读子代理（general-purpose）：tools 保持空数组（不传 --tools 全量放行），-e 不含 pi-mcp-adapter", async () => {
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
  //（含 pi 内置 MCP 扩展注册的 mcp__<server>__<tool>），无需白名单合并
  expect(gp.tools).toEqual([]);
  const extPaths: string[] = capturedSpawnOpts[0]?.extensionPaths ?? [];
  expect(extPaths.some((p) => p.includes("pi-mcp-adapter"))).toBe(false);
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
  // 原始设计：命名智能体按「智能体设置-工具」勾选集透传，不自动并入 MCP 工具名
  //（需要 MCP 工具可显式勾选，或不勾选走全放行）
  expect(named.tools).toEqual(["read", "grep"]);
});
