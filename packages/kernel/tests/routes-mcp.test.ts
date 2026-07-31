/**
 * MCP 域路由测试（阶段二·去 WS 化）
 *
 * 聚焦 bug：mcp:test / mcp:clearAuth 的 mcp:testResult 必须通过 SSE 总线
 * 广播到前端，否则前端 testingServers 永远不会被清理，所有服务卡在"测试中"。
 *
 * 验证链路：POST /api/mcp/test → handler 显式 broadcast → SSE /api/events 收到 mcp:testResult。
 * 使用真实 echo MCP 固定件（tests/fixtures/echo-mcp-server.ts）做 stdio 握手，
 * 不 mock MCP SDK；mcpStore / agentManager / projectStore 用最小桩。
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import type { McpServerConfig } from "@wa-pi/shared";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-mcp-server.ts");
const STDIO_SERVER: McpServerConfig = {
  name: "echo",
  command: process.execPath,
  args: [FIXTURE],
};

/** 最小 mcpStore 桩：只实现 mcp:test / mcp:clearAuth 用到的方法 */
function makeMcpStore() {
  const servers: Record<string, McpServerConfig> = { echo: STDIO_SERVER };
  return {
    async list() { return Object.values(servers); },
    async getServer(name: string) { return servers[name]; },
    async save(cfg: McpServerConfig) { servers[cfg.name] = cfg; },
    async delete(name: string) { delete servers[name]; },
  };
}

/** 最小 agentManager 桩：仅满足 WSServer 构造与 disposeAll */
function makeAgentManager() {
  return { disposeAll: async () => {}, onEvent: () => {} };
}

/** 最小 projectStore 桩：仅满足 WSServer 构造 */
function makeProjectStore() {
  return { load: async () => ({ projects: [], sessions: [] }) };
}

let server: WSServer;
let base: string;
let sseReader: ReadableStreamDefaultReader<Uint8Array>;
let sseBuf = "";

beforeAll(async () => {
  server = new WSServer({
    agentManager: makeAgentManager() as any,
    mcpStore: makeMcpStore() as any,
    projectStore: makeProjectStore() as any,
    // chat 域测试不涉及的 store/manager：空桩满足 WSServerOpts 结构
    configStore: {} as any,
    providerStore: {} as any,
    skillManager: {} as any,
    extensionManager: {} as any,
    memoryStore: {} as any,
    port: 0, // 随机端口
  });
  await server.start();
  base = `http://localhost:${server.actualPort}`;

  // 先建 SSE 长连接，订阅后续广播
  const sse = await fetch(`${base}/api/events`);
  sseReader = sse.body!.getReader();
});

afterAll(async () => {
  await sseReader?.cancel().catch(() => {});
  // WSServer.stop() 内部调用 Bun.serve 的 stop() 关闭连接
  server?.stop();
});

/** 从 SSE 流读出下一条 data: 帧（跳过注释行/心跳） */
async function readSseEvent(timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      sseReader.read(),
      new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), deadline - Date.now())),
    ]);
    if ((chunk as any).done) continue;
    sseBuf += new TextDecoder().decode((chunk as any).value);
    const idx = sseBuf.indexOf("\n\n");
    if (idx === -1) continue;
    const frame = sseBuf.slice(0, idx);
    sseBuf = sseBuf.slice(idx + 2);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try { return JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
  }
  throw new Error("readSseEvent 超时未收到事件");
}

test("POST /api/mcp/test 成功 → SSE 广播 mcp:testResult（status:connected），前端据此翻转 testingServers", async () => {
  const res = await fetch(`${base}/api/mcp/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverName: "echo" }),
  });
  expect(res.status).toBe(200);
  // fire-and-forget：HTTP 响应体不携带结果（前端也不读）
  expect(await res.json()).toEqual({ ok: true });

  // 关键断言：SSE 总线收到 mcp:testResult（修复前这里会永久超时）
  const ev = await readSseEvent();
  expect(ev.type).toBe("mcp:testResult");
  expect(ev.serverName).toBe("echo");
  expect(ev.success).toBe(true);
  expect(ev.status).toBe("connected");
  expect(ev.toolCount).toBe(2); // echo fixture 暴露 2 个工具
});

test("POST /api/mcp/test 未知 server → SSE 广播 mcp:testResult（status:error）", async () => {
  // 排空上一轮残留事件，避免读到上一个 echo 的事件
  sseBuf = "";
  const res = await fetch(`${base}/api/mcp/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverName: "not-exist" }),
  });
  expect(res.status).toBe(200);
  // 持续读直到拿到 not-exist 的事件（可能先读到上轮残留的 echo 事件）
  let ev: any;
  for (let i = 0; i < 5; i++) {
    ev = await readSseEvent();
    if (ev.type === "mcp:testResult" && ev.serverName === "not-exist") break;
  }
  expect(ev.type).toBe("mcp:testResult");
  expect(ev.serverName).toBe("not-exist");
  expect(ev.success).toBe(false);
  expect(ev.status).toBe("error");
});

test("GET /api/mcp/:serverName/tools → SSE 广播 mcp:tools，前端据此填充 toolsCache", async () => {
  const res = await fetch(`${base}/api/mcp/echo/tools`);
  expect(res.status).toBe(200);
  // fire-and-forget：HTTP 响应体不携带结果
  expect(await res.json()).toEqual({ ok: true });

  // 关键断言：SSE 总线收到 mcp:tools
  let ev: any;
  for (let i = 0; i < 5; i++) {
    ev = await readSseEvent();
    if (ev.type === "mcp:tools" && ev.serverName === "echo") break;
  }
  expect(ev.type).toBe("mcp:tools");
  expect(ev.serverName).toBe("echo");
  expect(Array.isArray(ev.tools)).toBe(true);
  expect(ev.tools.length).toBe(2); // echo fixture 暴露 echo + ping 两个工具
  expect(ev.tools.map((t: any) => t.name).sort()).toEqual(["echo", "ping"]);
});
