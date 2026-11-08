// 路由层回归测试（TDD 先红）：test / listTools 改走单台探测（mcp-probe），
// 与全量 `pi mcp list` 彻底解耦——状态读取层（admin）卡死/失败时，
// 单台测试仍能独立返回结果（2026-11-04 缺陷：hlk 刷新挂 60s 拖死所有台的测试）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandlers } from "../routes/mcp";
import { McpFile } from "../mcp-file";
import type { WSServerEvent } from "@wa-pi/shared";

/** stdio mock server：initialize + tools/list 正常应答 */
const STDIO_SERVER_SCRIPT = `// 行分隔 JSON-RPC mock
const dec = new TextDecoder();
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += dec.decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" } },
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        // 带 description + inputSchema：路由层必须原样透传（“查看工具”弹窗要显示简介/参数）
        result: { tools: [
          {
            name: "tool_x",
            description: "列出 X",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "integer", description: "上限" } },
              required: ["limit"],
            },
          },
          { name: "tool_y" },
        ] },
      }) + "\\n");
    }
  }
});
`;

describe("MCP 路由：test/listTools 单台独立（不再依赖全量 list）", () => {
  let dir: string;
  let scriptPath: string;
  let hangPort: number;
  let hangServer: ReturnType<typeof Bun.serve>;
  const events: WSServerEvent[] = [];
  let handlers: ReturnType<typeof createMcpHandlers>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-routes-"));
    scriptPath = join(dir, "mock-stdio-server.ts");
    writeFileSync(scriptPath, STDIO_SERVER_SCRIPT);
    // 一台永远挂住的 http server（模拟 hlk 刷新卡死）
    hangServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    hangPort = hangServer.port as number;

    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "dbx-ok": {
            type: "stdio",
            command: process.execPath,
            args: [scriptPath],
            enabled: true,
          },
          "hlk-hang": {
            type: "http",
            url: `http://127.0.0.1:${hangPort}/mcp`,
            enabled: true,
          },
          "turned-off": {
            type: "stdio",
            command: process.execPath,
            args: [scriptPath],
            enabled: false,
          },
        },
      }),
    );

    handlers = createMcpHandlers({
      mcpFile: new McpFile({
        globalPath: join(dir, "mcp.json"),
        projectPathFor: async () => join(dir, "project-mcp.json"),
      }),
      cwdForProject: async () => dir,
      // 状态读取层（pi mcp list 的唯一读取者）整体卡死：旧实现下 test/listTools 会被拖死
      adminForCwd: () => ({
        list: () => new Promise(() => {}),
        invalidate: () => {},
        cached: () => false,
      }),
      invalidateCaches: () => {},
      broadcast: (e) => events.push(e),
      piSpawn: { runtime: "bun", cliPath: "unused.js", agentDir: dir },
    });
  });

  afterAll(async () => {
    hangServer.stop(true);
    // Windows 句柄释放竞争：stdio 探测子进程/socket 句柄可能晚于 stop 释放，立即 rm
    // 偶发 EBUSY（2026-11-07 全量实测一次）；短延迟 + 尽力而为，锁住不视为失败
    //（目录随进程退出自然释放，与 memory-backfill-wiring 清理同策略）
    await new Promise((r) => setTimeout(r, 300));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 目录被句柄短暂锁住属预期 */
    }
  });

  test("状态读取层卡死时，stdio 台的连接测试仍秒级返回 connected", async () => {
    events.length = 0;
    const t0 = Date.now();
    await handlers.test({ serverName: "dbx-ok" });
    const elapsed = Date.now() - t0;
    const last = events.at(-1) as { type: string; serverName: string; status: string; toolCount?: number };
    expect(last.type).toBe("mcp:testResult");
    expect(last.serverName).toBe("dbx-ok");
    expect(last.status).toBe("connected");
    expect(last.toolCount).toBe(2);
    expect(elapsed).toBeLessThan(5000);
  });

  test("状态读取层卡死时，挂住的 http 台按探测超时判失败，只影响它自己", async () => {
    events.length = 0;
    await handlers.test({ serverName: "hlk-hang" });
    const last = events.at(-1) as { type: string; serverName: string; status: string; success: boolean };
    expect(last.type).toBe("mcp:testResult");
    expect(last.serverName).toBe("hlk-hang");
    expect(last.success).toBe(false);
    expect(last.status).toBe("error");
  }, 15000); // 探测默认上限 10s，放宽 bun test 框架超时

  test("listTools 走单台探测，返回该台工具清单（含简介与参数）", async () => {
    events.length = 0;
    await handlers.listTools({ serverName: "dbx-ok" });
    const last = events.at(-1) as { type: string; serverName: string; tools?: unknown[] };
    expect(last.type).toBe("mcp:tools");
    expect(last.serverName).toBe("dbx-ok");
    expect(last.tools).toEqual([
      {
        name: "tool_x",
        description: "列出 X",
        parameters: [{ name: "limit", type: "integer", description: "上限", required: true }],
      },
      { name: "tool_y" },
    ]);
  });

  test("不存在的 server → 广播错误并带 mcp.serverNotFound", async () => {
    events.length = 0;
    await handlers.test({ serverName: "ghost" });
    const last = events.at(-1) as {
      type: string;
      serverName: string;
      status: string;
      code?: string;
    };
    expect(last.type).toBe("mcp:testResult");
    expect(last.status).toBe("error");
    expect(last.code).toBe("mcp.serverNotFound");
  });

  test("enabled:false 的台 → 广播 disconnected（不发起连接）", async () => {
    events.length = 0;
    await handlers.test({ serverName: "turned-off" });
    const last = events.at(-1) as { type: string; serverName: string; status: string };
    expect(last.type).toBe("mcp:testResult");
    expect(last.serverName).toBe("turned-off");
    expect(last.status).toBe("disconnected");
  });
});
