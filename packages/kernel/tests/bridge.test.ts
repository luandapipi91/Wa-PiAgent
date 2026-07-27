// bridge 扩展层测试：
// - ensureBridgeExtension 生成文件 + 幂等覆盖
// - 契约：生成的扩展与现有实现（ask-tool / amaster-memory / delegate-tool）的
//   name/description/schema 完全一致（agent 可见契约不变）
// - 真实 pi --mode rpc 加载扩展不崩（get_state / get_commands）
// - handleBridgeRequest：token / session 校验与结果透传
// - makeDefaultBridgeContext：ask 复用逻辑、memory 回路、delegate/fleet 桩
// - ws-server /bridge/tool 路由 + 扩展 execute 经真实 HTTP 的全链路
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureBridgeExtension,
  generateBridgeExtension,
  BRIDGE_EXTENSION_PATH,
} from "../src/bridge-extension";
import {
  registerBridgeSession,
  unregisterBridgeSession,
  getBridgeToken,
  handleBridgeRequest,
  makeDefaultBridgeContext,
  type BridgeSessionContext,
} from "../src/bridge-registry";
import { askRegistry } from "../src/ask-registry";
import { makeAskTool } from "../src/ask-tool";
import { createAgentMemoryTools, getGlobalMemoryStore, getProjectMemoryStore } from "../src/amaster-memory";
import { makeDelegateTool, makeFleetTool } from "../src/delegate-tool";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { RpcClient, buildPiArgs, resolvePiCliPath } from "../src/rpc-client";
import type { AskParams } from "@hiagent/shared";

const SEVEN_TOOLS = [
  "ask_user_question",
  "memory_add",
  "memory_replace",
  "memory_remove",
  "memory_read",
  "delegate",
  "fleet",
];

const validAskParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

let tmpDir: string;
const tmpFiles: string[] = [];
const clients: RpcClient[] = [];

beforeEach(() => {
  askRegistry.reset();
  tmpDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
});

afterEach(async () => {
  unregisterBridgeSession("s1");
  unregisterBridgeSession("s-bridge");
  rmSync(tmpDir, { recursive: true, force: true });
  for (const f of tmpFiles.splice(0)) rmSync(f, { force: true });
  for (const c of clients.splice(0)) await c.dispose().catch(() => {});
  delete process.env.HIAGENT_BRIDGE_URL;
  delete process.env.HIAGENT_BRIDGE_TOKEN;
  delete process.env.HIAGENT_SESSION_ID;
});

// 生成的扩展文件是 kernel 启动产物（startKernel 会幂等重写），测完删除不污染环境
afterAll(() => {
  rmSync(BRIDGE_EXTENSION_PATH, { force: true });
  rmSync(join(BRIDGE_EXTENSION_PATH, "..", "tool-schemas.ts"), { force: true });
});

/** 把 bridge 扩展源码 + tool-schemas 依赖写到 tests 内的临时目录并动态 import，
 *  返回捕获到的 7 个 registerTool 定义。 */
async function loadBridgeTools(env?: Record<string, string>) {
  for (const [k, v] of Object.entries(env ?? {})) process.env[k] = v;
  const file = join(import.meta.dir, `.tmp-bridge-${Math.random().toString(36).slice(2)}.ts`);
  // 静态 bridge 扩展 import "./tool-schemas.ts"，需把 tool-schemas 复制到同目录
  const schemasFile = join(import.meta.dir, "tool-schemas.ts");
  const schemasSrc = join(import.meta.dir, "..", "..", "shared", "src", "tool-schemas.ts");
  const { copyFileSync } = await import("node:fs");
  copyFileSync(schemasSrc, schemasFile);
  tmpFiles.push(schemasFile);
  writeFileSync(file, generateBridgeExtension(), "utf8");
  tmpFiles.push(file);
  const mod = await import(pathToFileURL(file).href);
  const tools: any[] = [];
  mod.default({ registerTool: (def: any) => tools.push(def) });
  return tools;
}

function makeMemoryStores() {
  return {
    global: getGlobalMemoryStore(tmpDir),
    project: getProjectMemoryStore(tmpDir, join(tmpDir, "repos", "my-app")),
  };
}

// ---- ensureBridgeExtension ----

test("ensureBridgeExtension 生成文件存在且包含 7 个工具名，幂等覆盖", async () => {
  const p1 = await ensureBridgeExtension();
  expect(p1).toBe(BRIDGE_EXTENSION_PATH);
  expect(existsSync(p1)).toBe(true);
  const code = readFileSync(p1, "utf8");
  for (const name of SEVEN_TOOLS) {
    expect(code).toContain(`name: "${name}"`);
  }
  // 幂等：再次调用覆盖写，不报错、内容一致
  const p2 = await ensureBridgeExtension();
  expect(p2).toBe(p1);
  expect(readFileSync(p2, "utf8")).toBe(code);
});

// ---- 契约：生成的扩展与现有实现完全一致 ----

test("契约：扩展工具的 name/description/schema 与现有实现一致", async () => {
  const bridgeTools = await loadBridgeTools();
  expect(bridgeTools.map((t) => t.name).sort()).toEqual([...SEVEN_TOOLS].sort());

  // ask：name/label/description/promptGuidelines/parameters 全等
  const askReal = makeAskTool("s1") as any;
  const askBridge = bridgeTools.find((t) => t.name === "ask_user_question");
  expect(askBridge.label).toBe(askReal.label);
  expect(askBridge.description).toBe(askReal.description);
  expect(askBridge.promptGuidelines).toEqual(askReal.promptGuidelines);
  expect(JSON.parse(JSON.stringify(askBridge.parameters))).toEqual(JSON.parse(JSON.stringify(askReal.parameters)));

  // memory_*：4 个工具逐一比对（含 promptSnippet）
  const stores = makeMemoryStores();
  const memReal = createAgentMemoryTools(stores.global, stores.project) as any[];
  for (const real of memReal) {
    const bridge = bridgeTools.find((t) => t.name === real.name);
    expect(bridge, `缺少 ${real.name}`).toBeTruthy();
    expect(bridge.label).toBe(real.label);
    expect(bridge.description).toBe(real.description);
    expect(bridge.promptSnippet).toBe(real.promptSnippet);
    expect(JSON.parse(JSON.stringify(bridge.parameters))).toEqual(JSON.parse(JSON.stringify(real.parameters)));
  }

  // delegate / fleet
  const spawn = async () => ({ text: "", isError: false });
  const delegateReal = makeDelegateTool({ askTo: [], spawn });
  const delegateBridge = bridgeTools.find((t) => t.name === "delegate");
  expect(delegateBridge.label).toBe(delegateReal.label);
  expect(delegateBridge.description).toBe(delegateReal.description);
  expect(JSON.parse(JSON.stringify(delegateBridge.parameters))).toEqual(JSON.parse(JSON.stringify(delegateReal.parameters)));

  const fleetReal = makeFleetTool({ askTo: [], spawn });
  const fleetBridge = bridgeTools.find((t) => t.name === "fleet");
  expect(fleetBridge.label).toBe(fleetReal.label);
  expect(fleetBridge.description).toBe(fleetReal.description);
  expect(JSON.parse(JSON.stringify(fleetBridge.parameters))).toEqual(JSON.parse(JSON.stringify(fleetReal.parameters)));
});

// ---- 真实 pi 加载 ----

test("真实 pi --mode rpc 加载 bridge 扩展不崩（get_state / get_commands）", async () => {
  const extPath = await ensureBridgeExtension();
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    runtime: process.execPath,
    args: buildPiArgs({ noSession: true, offline: true, extensionPaths: [extPath] }),
    cwd: import.meta.dir,
    env: { PI_CODING_AGENT_DIR: join(import.meta.dir, "fixtures", "pi-agent-dir-test") },
    onEvent: () => {},
  });
  clients.push(client);
  await client.start();
  const state = await client.getState();
  expect(typeof state.sessionId).toBe("string");
  // 扩展加载失败会让进程出错或命令失败；能拿到 commands 即说明注册没把进程弄崩
  const data = await client.command({ type: "get_commands" });
  expect(Array.isArray(data?.commands)).toBe(true);
}, 30_000);

// ---- handleBridgeRequest ----

test("handleBridgeRequest：token 错误 → 401 invalid_token", async () => {
  const r = await handleBridgeRequest({ token: "wrong", sessionId: "s1", toolCallId: "tc1", tool: "delegate", params: {} });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.status).toBe(401);
    expect(r.error).toBe("invalid_token");
  }
});

test("handleBridgeRequest：非法 body / 缺字段 → 400", async () => {
  const r1 = await handleBridgeRequest(null);
  expect(r1.ok).toBe(false);
  if (!r1.ok) expect(r1.status).toBe(400);
  const r2 = await handleBridgeRequest({ token: getBridgeToken() });
  expect(r2.ok).toBe(false);
  if (!r2.ok) expect(r2.status).toBe(400);
});

test("handleBridgeRequest：sessionId 未注册 → 404 unknown_session", async () => {
  const r = await handleBridgeRequest({ token: getBridgeToken(), sessionId: "nobody", toolCallId: "tc1", tool: "delegate", params: {} });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.status).toBe(404);
    expect(r.error).toBe("unknown_session");
  }
});

test("handleBridgeRequest：已注册 → 调用 ctx.handleTool 并透传结果", async () => {
  const seen: Array<{ tool: string; toolCallId: string; params: unknown }> = [];
  const ctx: BridgeSessionContext = {
    cwd: "/tmp",
    async handleTool(tool, toolCallId, params) {
      seen.push({ tool, toolCallId, params });
      return { content: [{ type: "text", text: "宿主结果" }], details: { ok: 1 } };
    },
  };
  registerBridgeSession("s1", ctx);
  const r = await handleBridgeRequest({ token: getBridgeToken(), sessionId: "s1", toolCallId: "tc9", tool: "memory_read", params: { target: "memory" } });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.result.content[0].text).toBe("宿主结果");
    expect((r.result.details as any).ok).toBe(1);
  }
  expect(seen).toEqual([{ tool: "memory_read", toolCallId: "tc9", params: { target: "memory" } }]);
});

// ---- makeDefaultBridgeContext：ask 复用逻辑 ----

test("default ctx：ask 校验失败 → details.error，不阻塞", async () => {
  const ctx = makeDefaultBridgeContext({ sessionId: "s1", cwd: tmpDir, memoryStores: makeMemoryStores() });
  const out = await ctx.handleTool("ask_user_question", "tc1", { questions: [] }, new AbortController().signal);
  expect((out.details as any).error).toBe("no_questions");
  expect((out.details as any).cancelled).toBe(false);
});

test("default ctx：ask cancel → details.cancelled=true", async () => {
  const ctx = makeDefaultBridgeContext({ sessionId: "s1", cwd: tmpDir, memoryStores: makeMemoryStores() });
  const p = ctx.handleTool("ask_user_question", "tc1", validAskParams, new AbortController().signal);
  askRegistry.cancel("s1", "tc1");
  const out = await p;
  expect((out.details as any).cancelled).toBe(true);
  expect(out.content[0].text).toBe("用户取消了提问");
});

test("default ctx：ask 正常 answers 文本拼接", async () => {
  const ctx = makeDefaultBridgeContext({ sessionId: "s1", cwd: tmpDir, memoryStores: makeMemoryStores() });
  const p = ctx.handleTool("ask_user_question", "tc1", validAskParams, new AbortController().signal);
  askRegistry.resolve("s1", "tc1", { replies: [{ questionIndex: 0, selected: ["A"] }] });
  const out = await p;
  expect((out.details as any).cancelled).toBe(false);
  expect((out.details as any).answers[0]).toMatchObject({ kind: "option", answer: "A" });
  expect(out.content[0].text).toBe("Q: Q?\nA: A");
});

// ---- makeDefaultBridgeContext：memory 回路 / delegate 桩 ----

test("default ctx：memory_add 后 memory_read 能读回", async () => {
  const ctx = makeDefaultBridgeContext({ sessionId: "s1", cwd: tmpDir, memoryStores: makeMemoryStores() });
  const signal = new AbortController().signal;
  await ctx.handleTool("memory_add", "tc1", { target: "memory", content: "bridge 记忆条目" }, signal);
  const out = await ctx.handleTool("memory_read", "tc2", { target: "memory" }, signal);
  expect(out.content[0].text).toContain("bridge 记忆条目");
});

test("default ctx：delegate/fleet 返回 not_wired 桩", async () => {
  const ctx = makeDefaultBridgeContext({ sessionId: "s1", cwd: tmpDir, memoryStores: makeMemoryStores() });
  const signal = new AbortController().signal;
  for (const tool of ["delegate", "fleet"]) {
    const out = await ctx.handleTool(tool, "tc1", {}, signal);
    expect((out.details as any).error).toBe("not_wired");
    expect(out.content[0].text).toContain("尚未接入 bridge");
  }
});

// ---- ws-server /bridge/tool 路由 ----

/** 起最小 WSServer（mock agentManager），返回端口与停止函数。
 *  所有 store 路径落在 tmpDir 内，afterEach 统一清理，不在 tests/ 下留残留。 */
async function startTestServer() {
  const rand = () => join(tmpDir, "ws-bridge-" + Math.random().toString(36).slice(2));
  const dataDir = rand();
  const server = new WSServer({
    configStore: new ConfigStore(rand()),
    projectStore: new ProjectStore(rand() + ".json"),
    providerStore: new ProviderStore(rand() + ".json"),
    skillManager: new SkillManager(rand()),
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: null as any,
    mcpStore: null as any,
    dataDir,
    agentManager: { disposeAll: async () => {} } as any,
    port: 0,
  });
  await server.start();
  return { server, port: server.actualPort };
}

test("/bridge/tool 路由：401 / 404 / 200", async () => {
  const { server, port } = await startTestServer();
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/bridge/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // token 错误 → 401
    const r401 = await post({ token: "wrong", sessionId: "s1", toolCallId: "tc1", tool: "delegate", params: {} });
    expect(r401.status).toBe(401);
    expect((await r401.json()).error).toBe("invalid_token");

    // session 未注册 → 404
    const r404 = await post({ token: getBridgeToken(), sessionId: "s1", toolCallId: "tc1", tool: "delegate", params: {} });
    expect(r404.status).toBe(404);

    // 注册后 → 200 透传 { content, details }
    registerBridgeSession("s1", {
      cwd: "/tmp",
      async handleTool() {
        return { content: [{ type: "text", text: "路由结果" }], details: { via: "http" } };
      },
    });
    const r200 = await post({ token: getBridgeToken(), sessionId: "s1", toolCallId: "tc1", tool: "delegate", params: {} });
    expect(r200.status).toBe(200);
    const data = await r200.json();
    expect(data.content[0].text).toBe("路由结果");
    expect(data.details.via).toBe("http");
  } finally {
    await server.stop();
  }
});

// ---- 扩展 execute 经真实 HTTP 的全链路 ----

test("扩展 execute：缺 env 报 missing_env；配好 env 后经 ws-server 全链路执行", async () => {
  // 缺 env：明确错误文本，不抛出
  const noEnvTools = await loadBridgeTools();
  const miss = await noEnvTools.find((t: any) => t.name === "delegate").execute("tc1", { agent: "a", task: "b" }, undefined);
  expect(miss.details.error).toBe("missing_env");
  expect(miss.content[0].text).toContain("只在 hiagent 宿主下可用");

  // 配好 env：ask 走完整 HTTP 链路（扩展 → ws-server → registry → askRegistry）
  const { server, port } = await startTestServer();
  try {
    const ctx = makeDefaultBridgeContext({ sessionId: "s-bridge", cwd: tmpDir, memoryStores: makeMemoryStores() });
    registerBridgeSession("s-bridge", ctx);
    const tools = await loadBridgeTools({
      HIAGENT_BRIDGE_URL: `http://127.0.0.1:${port}`,
      HIAGENT_BRIDGE_TOKEN: getBridgeToken(),
      HIAGENT_SESSION_ID: "s-bridge",
    });

    // ask：阻塞等回答，resolve 后文本经 HTTP 回传到 pi 侧
    const askTool = tools.find((t: any) => t.name === "ask_user_question");
    const p = askTool.execute("tc-http", validAskParams, undefined);
    // 等请求到达 kernel 并挂上 pending 再回答
    await new Promise((r) => setTimeout(r, 300));
    askRegistry.resolve("s-bridge", "tc-http", { replies: [{ questionIndex: 0, selected: ["B"] }] });
    const askOut = await p;
    expect(askOut.details.cancelled).toBe(false);
    expect(askOut.content[0].text).toBe("Q: Q?\nA: B");

    // delegate 桩：经 HTTP 链路返回 not_wired
    const delegateTool = tools.find((t: any) => t.name === "delegate");
    const stub = await delegateTool.execute("tc2", { agent: "a", task: "b" }, undefined);
    expect(stub.details.error).toBe("not_wired");
  } finally {
    await server.stop();
  }
});
