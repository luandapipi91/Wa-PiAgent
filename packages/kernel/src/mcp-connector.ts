// mcp-connector.ts — MCP 连接测试 / 工具列举 / 授权清理
//
// 连接逻辑镜像 pi-mcp-adapter 的 McpServerManager.createConnection：用同一个
// @modelcontextprotocol/sdk（纯 JS，可随内核 bundle）创建 Client + 传输层，
// 握手后列举工具。不深导入 adapter 内部模块——adapter 由 Pi SDK 在运行时通过
// additionalExtensionPaths 动态加载，不进 kernel.js bundle；若深导入其
// server-manager 会把 recheck/open 等重依赖拖进内核编译产物。
//
// 三类结果：
// - connected：握手成功，附带工具数
// - needs_auth：服务器返回 401 UnauthorizedError（OAuth 待授权）
// - error：其它失败，附带错误信息

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { removeAuthEntry } from "pi-mcp-adapter/mcp-auth.ts";
import type { McpServerConfig, McpServerStatus, McpToolParam, McpToolSummary } from "@hiagent/shared";

/** 连接超时：MCP 握手 + 工具发现通常 < 5s，20s 兜底慢启动 / npx 拉包 */
const CONNECT_TIMEOUT_MS = 20_000;

export interface McpTestOutcome {
  status: McpServerStatus;
  toolCount?: number;
  error?: string;
}

/** 测试连接：连上返回 connected + 工具数；需授权返回 needs_auth；失败返回 error */
export async function testConnection(
  config: McpServerConfig,
  defaultCwd?: string,
): Promise<McpTestOutcome> {
  try {
    return await withConnection(config, defaultCwd, async (client, signal) => {
      const tools = await fetchAllTools(client, signal);
      return { status: "connected", toolCount: tools.length };
    });
  } catch (err) {
    if (isNeedsAuth(err)) return { status: "needs_auth" };
    return { status: "error", error: errorMessage(err) };
  }
}

/** 实时列举工具：连接后读取 tools 再断开；连接失败返回空数组 */
export async function listTools(
  config: McpServerConfig,
  defaultCwd?: string,
): Promise<McpToolSummary[]> {
  try {
    return await withConnection(config, defaultCwd, async (client, signal) => {
      const tools = await fetchAllTools(client, signal);
      return tools.map(toToolSummary);
    });
  } catch {
    return [];
  }
}

/** 清除授权：删除已存的 OAuth token 文件 + 服务器目录，下次连接重新走授权流程。
 *  复用 adapter 的 removeAuthEntry（仅依赖 node 内建，可随内核 bundle），
 *  不走 removeAuth 的完整 OAuth 回调服务清理——连接器无活动会话，无需清理回调态 */
export async function clearAuth(serverName: string): Promise<void> {
  removeAuthEntry(serverName);
}

// ===== 内部 =====

/** 建连 → 执行 fn → 无论成败都关闭 client/transport（避免 stdio 子进程残留） */
async function withConnection<T>(
  config: McpServerConfig,
  defaultCwd: string | undefined,
  fn: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: `hiagent-mcp-${config.name}`, version: "1.0.0" });
  const transport = createTransport(config, defaultCwd);
  const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
  try {
    await client.connect(transport, { signal });
    return await fn(client, signal);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function createTransport(config: McpServerConfig, defaultCwd?: string) {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: resolveEnv(config.env),
      cwd: config.cwd ?? defaultCwd,
    });
  }
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  throw new Error(`MCP 服务器 ${config.name} 缺少 command 或 url`);
}

async function fetchAllTools(client: Client, signal: AbortSignal) {
  const all: { name: string; description?: string; inputSchema?: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
    all.push(...(result.tools ?? []));
    cursor = result.nextCursor;
  } while (cursor);
  return all;
}

function toToolSummary(tool: { name: string; description?: string; inputSchema?: unknown }): McpToolSummary {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toParams(tool.inputSchema),
  };
}

function toParams(inputSchema: unknown): McpToolParam[] | undefined {
  if (!inputSchema || typeof inputSchema !== "object") return undefined;
  const schema = inputSchema as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  if (!schema.properties) return undefined;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, p]) => ({
    name,
    type: p.type ?? "string",
    description: p.description,
    required: required.has(name),
  }));
}

/** 合并 process.env 与配置 env（配置优先）。未配置时返回 undefined 以继承父进程 env */
function resolveEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  for (const [k, v] of Object.entries(env)) merged[k] = v;
  return merged;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "连接失败";
  return String(err) || "连接失败";
}

/** 401：OAuth 待授权。两条路径——带 authProvider 时 SDK 抛 UnauthorizedError；
 *  无 authProvider（我们的 HTTP 客户端不挂 OAuth 流）时抛 StreamableHTTPError(code=401) */
function isNeedsAuth(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  return err instanceof StreamableHTTPError && err.code === 401;
}
