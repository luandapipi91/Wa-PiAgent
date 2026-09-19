// tests/mcp-connector.test.ts — MCP 连接器测试
//
// 用真实的 MCP 服务器（stdio 固定件 + 原生 HTTP 401 服务器）验证连接逻辑，
// 不 mock 任何 MCP SDK 内部。固定件进程由 testConnection 通过 StdioClientTransport 拉起。

import { test, expect } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
} from "node:http";
import { testConnection, listTools } from "../src/mcp-connector";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@wa-pi/shared";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-mcp-server.ts");

// 关键：process.execPath 在打包环境（~/.pi/agent/bin/bun 是 shim → exec 到 WaPiKernel）
// 指向编译产物 WaPiKernel。spawn 它跑 fixture 时必须带 BUN_BE_BUN=1，否则 WaPiKernel
// 以内核模式启动（监听 WS 端口 → EADDRINUSE → stderr 输出 kernel 日志 → 非 JSON），
// SDK StdioClientTransport 收不到 JSON-RPC 导致连接挂起。生产走 startKernel 的
// ensureBunBeBunEnv() 已注入该 env；测试不经 startKernel，需显式配置（见 src/index.ts:92）。
function stdioConfig(name = "echo"): McpServerConfig {
  return {
    name,
    command: process.execPath,
    args: [FIXTURE],
    env: { BUN_BE_BUN: "1" },
  };
}

/** 读 HTTP 请求体并 JSON.parse */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * 鉴权门控的 StreamableHTTP MCP 服务器，复刻 Zhipu/open.bigmodel.cn 行为：
 * 缺 Authorization 头 → 返回 {code,msg,success} 错误信封（非 JSON-RPC，正是
 * 触发 SDK JSONRPCMessageSchema Zod 报错的来源）；带头则走正常 MCP 握手。
 */
function startGatedHttpMcp(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer = createHttpServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer secret-token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 1001,
          msg: "Header中未收到Authorization参数",
          success: false,
        }),
      );
      return;
    }
    const mcp = new McpLowLevelServer(
      { name: "gated", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "probe",
          description: "probe tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    const body = await readBody(req);
    await transport.handleRequest(req, res, body);
    res.on("close", () => {
      transport.close();
      mcp.close().catch(() => {});
    });
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const port = (httpServer.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>((r) => httpServer.close(() => r())),
      });
    });
  });
}

// ===== Test 1: stdio 服务器连接成功 + 工具数 =====
test("testConnection: stdio 服务器连上后返回 connected + 工具数", async () => {
  const outcome = await testConnection(stdioConfig());
  expect(outcome.status).toBe("connected");
  expect(outcome.toolCount).toBe(2);
});

// ===== Test 2: listTools 返回工具摘要 =====
test("listTools: 返回工具摘要（name + description + parameters）", async () => {
  const tools = await listTools(stdioConfig());
  expect(tools).toHaveLength(2);
  expect(tools[0].name).toBe("echo");
  expect(tools[0].description).toBe("Echoes the given text");
  expect(tools[0].parameters).toEqual([
    {
      name: "text",
      type: "string",
      description: "Text to echo",
      required: true,
    },
  ]);
});

// ===== Test 5: 错误路径（返回 error 而不是挂起） =====
test("testConnection: 无效命令快速返回 error", async () => {
  const outcome = await testConnection({
    name: "bad",
    command: "definitely-not-a-real-command-xyz",
  });
  expect(outcome.status).toBe("error");
  expect(outcome.error).toBeTruthy();
});

test("testConnection: 无法连接的 URL 返回 error", async () => {
  const outcome = await testConnection({
    name: "dead",
    url: "http://127.0.0.1:1/mcp",
  });
  expect(outcome.status).toBe("error");
  expect(outcome.error).toBeTruthy();
});

// ===== Test 6: HTTP 服务器需 Authorization 头 → 必须转发 config.headers =====
test("testConnection: 需 Authorization 头的 HTTP 服务器转发 config.headers 后连上", async () => {
  const { url, close } = await startGatedHttpMcp();
  try {
    const outcome = await testConnection({
      name: "zhipu-like",
      url,
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(outcome.status).toBe("connected");
    expect(outcome.toolCount).toBe(1);
  } finally {
    await close();
  }
});

test("testConnection: 需 Authorization 头但未配置 headers 时返回 error（非 Zod 报错外泄）", async () => {
  const { url, close } = await startGatedHttpMcp();
  try {
    const outcome = await testConnection({ name: "zhipu-no-header", url });
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBeTruthy();
    // 错误信息应是可读的，不应是原始 Zod invalid_union JSON
    expect(outcome.error).not.toContain("invalid_union");
  } finally {
    await close();
  }
});

// ---- 任务 4 i18n：配置错误 code 化（用户可配置触发，outcome 携带结构化错误） ----

test("testConnection: url 非法 → outcome 携带 mcp.invalidUrl", async () => {
  const outcome = await testConnection({
    name: "badurl",
    url: "not-a-valid-url",
  });
  expect(outcome.status).toBe("error");
  expect(outcome.code).toBe("mcp.invalidUrl");
});

test("testConnection: 缺 command 与 url → outcome 携带 mcp.missingCommandOrUrl", async () => {
  const outcome = await testConnection({ name: "noconf" } as McpServerConfig);
  expect(outcome.status).toBe("error");
  expect(outcome.code).toBe("mcp.missingCommandOrUrl");
});
