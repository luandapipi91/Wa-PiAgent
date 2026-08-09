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
import type { McpServerConfig, McpServerStatus, McpToolParam, McpToolSummary } from "@wa-pi/shared";

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
    if (isJsonRpcSchemaError(err)) {
      return {
        status: "error",
        error: "服务器响应不是合法的 JSON-RPC 消息（通常是缺少 Authorization 头、鉴权失败，或该 URL 并非 MCP 端点）",
      };
    }
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

/** 清除授权：删除已存的 OAuth 凭据 + 服务器目录，下次连接重新走授权流程。
 *  复用 adapter 的 removeAuthEntry（2.13.0 起走 OS 凭据库 @napi-rs/keyring + 清理 legacy 文件），
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
  const client = new Client({ name: `wa-pi-mcp-${config.name}`, version: "1.0.0" });
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
    // 必须把 config.headers（如 Authorization）经 requestInit 透传给传输层，
    // 否则需鉴权的 HTTP MCP 服务器（如 Zhipu open.bigmodel.cn）会返回
    // {code,msg,success} 错误信封而非 JSON-RPC，触发 SDK 的 schema 校验报错。
    const headers = resolveHeaders(config.headers);
    const requestInit = headers ? { headers } : undefined;
    return new StreamableHTTPClientTransport(
      new URL(config.url),
      requestInit ? { requestInit } : undefined,
    );
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

/** 透传配置 headers（拷贝以防外部突变）；为空时返回 undefined */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.keys(headers).length > 0 ? { ...headers } : undefined;
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

// ===== MCP direct 工具名计算（RPC 迁移后替代 SDK loader 动态发现） =====

/**
 * direct 工具名命名规则与 pi-mcp-adapter（types.ts formatToolName）保持一致：
 * `<serverPrefix>_<toolName>`，"-" 统一归一为 "_"；prefix 模式 server/none/short。
 */
function serverPrefixOf(serverName: string, mode: "server" | "none" | "short"): string {
  if (mode === "none") return "";
  if (mode === "short") {
    const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return short || "mcp";
  }
  return serverName.replace(/-/g, "_");
}

function formatDirectToolName(toolName: string, serverName: string, mode: "server" | "none" | "short"): string {
  const p = serverPrefixOf(serverName, mode);
  const normalized = toolName.replace(/-/g, "_");
  return p ? `${p}_${normalized}` : normalized;
}

/**
 * 计算启用 directTools 的 MCP 服务器的 direct 工具名清单。
 * directTools 语义对齐 pi-mcp-adapter：true=全部工具直连，string[]=仅列出的工具，false/缺省=走 mcp 代理工具；
 * 服务器级配置优先于全局 settings.directTools。
 * 连接失败/超时的服务器静默跳过（这些工具本来也不可用）。
 *
 * 用途：受限 agent 的 --tools 白名单 + listGlobalTools 的动态发现
 * （SDK 时代由 DefaultResourceLoader 加载 adapter 后枚举，RPC 模式改为 kernel 侧主动计算）。
 */
export async function resolveMcpDirectToolNames(
  servers: McpServerConfig[],
  settings?: Record<string, unknown>,
): Promise<string[]> {
  const modeRaw = settings?.toolPrefix;
  const mode = (modeRaw === "none" || modeRaw === "short" ? modeRaw : "server") as "server" | "none" | "short";
  const globalDirect = settings?.directTools as true | string[] | undefined;

  const enabled = servers.filter((s) => {
    const dt = (s as McpServerConfig & { directTools?: unknown }).directTools;
    if (dt !== undefined) return !!dt;
    return !!globalDirect;
  });

  const names: string[] = [];
  const results = await Promise.allSettled(
    enabled.map(async (server) => {
      const dt =
        ((server as McpServerConfig & { directTools?: unknown }).directTools as true | string[] | undefined) ??
        globalDirect;
      const tools = await listTools(server);
      return tools
        .filter((t) => dt === true || !Array.isArray(dt) || dt.includes(t.name))
        .map((t) => formatDirectToolName(t.name, server.name, mode));
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled") names.push(...r.value);
  }
  return names;
}

/** 服务器返回了非 JSON-RPC 消息（如 Zhipu 的 {code,msg,success} 错误信封），
 *  SDK 的 JSONRPCMessageSchema.parse 抛 ZodError。识别后给可读提示，避免原始
 *  Zod 报错 JSON 外泄给用户 */
function isJsonRpcSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ZodError") return true;
  return err.message.includes("jsonrpc") && err.message.includes("invalid_union");
}
