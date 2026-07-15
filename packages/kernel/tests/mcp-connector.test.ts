// tests/mcp-connector.test.ts — MCP 连接器测试
//
// 用真实的 MCP 服务器（stdio 固定件 + 原生 HTTP 401 服务器）验证连接逻辑，
// 不 mock 任何 MCP SDK 内部。固定件进程由 testConnection 通过 StdioClientTransport 拉起。

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { testConnection, listTools, clearAuth } from "../src/mcp-connector";
import { saveAuthEntry, getAuthEntryFilePath } from "pi-mcp-adapter/mcp-auth.ts";
import type { McpServerConfig } from "@hiagent/shared";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-mcp-server.ts");

function stdioConfig(name = "echo"): McpServerConfig {
  return { name, command: process.execPath, args: [FIXTURE] };
}

// 401 HTTP 服务器：始终返回 401，模拟需 OAuth 授权的远端服务器
let unauthorizedServer: HttpServer;
let unauthorizedUrl = "";
beforeAll(async () => {
  unauthorizedServer = createHttpServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>(r => unauthorizedServer.listen(0, "127.0.0.1", r));
  const port = (unauthorizedServer.address() as { port: number }).port;
  unauthorizedUrl = `http://127.0.0.1:${port}/mcp`;
});
afterAll(() => new Promise<void>(r => unauthorizedServer.close(() => r())));

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
    { name: "text", type: "string", description: "Text to echo", required: true },
  ]);
});

// ===== Test 3: HTTP 401 → needs_auth =====
test("testConnection: HTTP 401 返回 needs_auth", async () => {
  const outcome = await testConnection({ name: "auth-required", url: unauthorizedUrl });
  expect(outcome.status).toBe("needs_auth");
});

// ===== Test 5: 错误路径（返回 error 而不是挂起） =====
test("testConnection: 无效命令快速返回 error", async () => {
  const outcome = await testConnection({ name: "bad", command: "definitely-not-a-real-command-xyz" });
  expect(outcome.status).toBe("error");
  expect(outcome.error).toBeTruthy();
});

test("testConnection: 无法连接的 URL 返回 error", async () => {
  const outcome = await testConnection({ name: "dead", url: "http://127.0.0.1:1/mcp" });
  expect(outcome.status).toBe("error");
  expect(outcome.error).toBeTruthy();
});

// ===== Test 4: clearAuth 删除已存授权 =====
test("clearAuth: 删除已存的 OAuth token 文件", async () => {
  const oauthDir = join(tmpdir(), `mcp-oauth-test-${Date.now()}`);
  process.env.MCP_OAUTH_DIR = oauthDir;
  try {
    saveAuthEntry("oauth-srv", { tokens: { access_token: "fake-token" } as never });
    expect(existsSync(getAuthEntryFilePath("oauth-srv"))).toBe(true);

    await clearAuth("oauth-srv");

    expect(existsSync(getAuthEntryFilePath("oauth-srv"))).toBe(false);
  } finally {
    delete process.env.MCP_OAUTH_DIR;
    rmSync(oauthDir, { recursive: true, force: true });
  }
});
