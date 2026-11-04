// 单台 MCP 探测器：对一台 server 发标准 MCP 协议的最小握手（initialize + tools/list）。
//
// 背景（2026-11-04 设计缺陷修复）：此前「连接测试 / 查看工具」走全量 `pi mcp list --json`，
// 一台 server 卡住（如 OAuth 刷新挂 60s）就把所有台的测试一起拖死。探测器让单台彻底独立：
// 纯 fetch / Bun.spawn 实现、单台一个总截止时间、不 import pi SDK（仓库约定 kernel 不引用
// pi SDK API）、不做 OAuth 刷新（刷新正是可能挂死的环节——token 过期如实报 needs-auth）。
//
// 协议子集（JSON-RPC 2.0，与 pi 连 server 的报文一致）：
//   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}        （握手）
//   ← result（HTTP 200；响应体可能是纯 JSON 或 SSE `data:` 行）
//   → {"jsonrpc":"2.0","method":"notifications/initialized"}               （通知，无 id）
//   → {"jsonrpc":"2.0","id":2,"method":"tools/list"}                        （拿工具名）
//   ← result.tools[].name
// stdio 传输为换行分隔 JSON（与 pi-mcp 的 stdio transport 一致）。
import { join } from "node:path";
import type { McpServerConfig } from "@wa-pi/shared";
import { WA_PI_DIR } from "@wa-pi/shared";
import { canUseOAuth, mcpNamespace, normalizeMcpAuthKey } from "./mcp-admin";

export type McpProbeState = "connected" | "needs-auth" | "failed" | "disabled";

export interface McpProbeResult {
  state: McpProbeState;
  tools: string[];
  error?: string;
}

export interface McpProbeOpts {
  /** 单台总截止时间（毫秒），缺省 10s；列表批量探测按台分档（http 3s / stdio 10s） */
  timeoutMs?: number;
  /** mcp-auth.json 所在目录，缺省 WA_PI_DIR */
  agentDir?: string;
  /**
   * stdio 子进程的**兜底 cwd**（调用方应传探测作用域的目录，与 pi spawn MCP 子进程同源）。
   * 缺省 WA_PI_DIR。绝不继承 kernel 进程 cwd：npx/npm 会读 cwd 的 package.json，
   * 在仓库/运行时目录里跑用户的 npx 命令会触发 EOVERRIDE 之类的 npm 错误而秒退
   * （2026-11-04 Context7 误报「连接失败」的根因——pi 的 cwd 是数据目录所以没这问题）。
   */
  cwd?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 失败结果快捷构造 */
function failed(error: string): McpProbeResult {
  return { state: "failed", tools: [], error };
}

/** 响应体解析：先按纯 JSON，失败再按 SSE 的 `data:` 行逐条试 */
function parseRpcPayload(text: string): JsonRpcResponse | null {
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim()) as JsonRpcResponse;
      } catch {
        // 不是 JSON 的 data 行（心跳注释等），继续找
      }
    }
    return null;
  }
}

function extractTools(payload: JsonRpcResponse | null): string[] {
  const result = payload?.result as { tools?: { name?: unknown }[] } | undefined;
  if (!Array.isArray(result?.tools)) return [];
  return result!.tools!.map((t) => (typeof t?.name === "string" ? t.name : "")).filter(Boolean);
}

function errorMessage(err: unknown): string {
  const e = err as Error;
  return e?.message ?? String(err);
}

/**
 * 读 `<agentDir>/mcp-auth.json` 里该 server（名 + URL）的**未过期** access_token。
 *
 * 探测不做 OAuth 刷新：token 过期就返回 null（请求将得到 401 → 如实报 needs-auth）。
 * 键形与 pi 一致（F19）：1.0.0 起 `mcp__<name>|<规范化URL>`，迁移前纯规范化 URL。
 */
async function readValidToken(
  agentDir: string,
  name: string,
  url: string,
): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await Bun.file(join(agentDir, "mcp-auth.json")).json();
  } catch {
    return null; // 文件不存在 / 损坏
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const canonical = normalizeMcpAuthKey(url);
  if (!canonical) return null;
  const map = raw as Record<string, { tokens?: { access_token?: unknown }; tokensExpireAt?: unknown }>;
  const entry = map[`${mcpNamespace(name)}|${canonical}`] ?? map[canonical];
  const token = entry?.tokens?.access_token;
  if (typeof token !== "string" || !token) return null;
  if (typeof entry!.tokensExpireAt === "number" && entry!.tokensExpireAt! <= Date.now()) return null;
  return token;
}

// ---------------------------------------------------------------- http 探测

async function probeHttp(
  config: McpServerConfig,
  deadline: number,
  agentDir: string,
): Promise<McpProbeResult> {
  const url = config.url!;
  // 凭据 token 只对「可能走 OAuth」的台读取：带静态 Authorization 头的台（如 yunxiao）
  // 直接用配置头，不读凭据文件（判据与 pi 一致，见 canUseOAuth）。
  let token: string | null = null;
  if (canUseOAuth(config)) {
    token = await readValidToken(agentDir, config.name, url!);
  }
  const buildHeaders = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...config.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  // 总截止：一个 AbortController 贯穿握手与取 body（abort 同样中断挂住的 body 读取）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, deadline - Date.now()));
  try {
    const initRes = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "wa-pi-probe", version: "1.0.0" },
        },
      }),
      signal: ac.signal,
    });
    if (initRes.status === 401 || initRes.status === 403) {
      return { state: "needs-auth", tools: [] };
    }
    if (!initRes.ok) return failed(`HTTP ${initRes.status}`);
    const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
    const initPayload = parseRpcPayload(await initRes.text());
    if (initPayload?.error) return failed(initPayload.error.message ?? "initialize 被拒绝");
    if (!initPayload?.result) return failed("响应不是有效的 MCP initialize 结果");

    // tools/list：拿工具名。此步失败不影响「已连接」的结论（tools 记为空）
    const headers = buildHeaders();
    if (sessionId) headers["mcp-session-id"] = sessionId;
    let tools: string[] = [];
    if (deadline - Date.now() > 0) {
      try {
        const toolsRes = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          signal: ac.signal,
        });
        if (toolsRes.ok) {
          tools = extractTools(parseRpcPayload(await toolsRes.text()));
        }
      } catch {
        // tools/list 失败不改变 connected 结论
      }
    }
    return { state: "connected", tools };
  } catch (err) {
    const e = err as Error;
    if (e?.name === "AbortError" || e?.name === "TimeoutError") {
      return failed("探测超时，未在设定时限内完成握手");
    }
    return failed(errorMessage(err));
  } finally {
    clearTimeout(timer);
  }
}


// --------------------------------------------------------------- stdio 探测

/**
 * stdio 子进程的 cwd 解析：config.cwd（用户显式配置）→ opts.cwd（作用域目录）→ WA_PI_DIR。
 * 见 {@link McpProbeOpts.cwd}——绝不能继承 kernel 进程 cwd。
 */
export function stdioCwd(config: McpServerConfig, opts: McpProbeOpts): string {
  return config.cwd ?? opts.cwd ?? WA_PI_DIR;
}

async function probeStdio(
  config: McpServerConfig,
  deadline: number,
  opts: McpProbeOpts,
): Promise<McpProbeResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn([config.command!, ...(config.args ?? [])], {
      env: { ...process.env, ...(config.env ?? {}) },
      cwd: stdioCwd(config, opts),
      stdin: "pipe",
      stdout: "pipe",
      // stderr 直接丢弃：mock server 与真 server 的调试输出不应阻塞管道（同 McpAdmin 的取舍）
      stderr: "ignore",
    });
  } catch (err) {
    return failed(`无法启动命令：${errorMessage(err)}`);
  }
  const cleanup = () => {
    try {
      proc.stdin?.end();
    } catch {
      /* 已关闭 */
    }
    try {
      proc.kill();
    } catch {
      /* 已退出 */
    }
  };

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 到点一次性 reject 的 deadline promise：所有读操作与它 race，保证单台总截止
  let fireDeadline: (() => void) | undefined;
  const deadlineHit = new Promise<"deadline">((resolve) => {
    fireDeadline = () => resolve("deadline");
  });
  const timer = setTimeout(() => fireDeadline?.(), Math.max(1, deadline - Date.now()));

  try {
    const stdin = proc.stdin;
    if (!stdin) return failed("子进程 stdin 不可用");
    const send = (msg: unknown) => {
      stdin.write(`${JSON.stringify(msg)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "wa-pi-probe", version: "1.0.0" },
      },
    });

    // 按行读 stdout：race 读流与到点；进程提前退出时 pipe 关闭，read 返回 done → 视为握手失败
    const readLine = async (): Promise<string | null> => {
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          return line || null;
        }
        const chunk = await Promise.race([reader.read(), deadlineHit]);
        if (chunk === "deadline") return null;
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };

    const initLine = await readLine();
    if (initLine === null) return failed("握手超时或进程提前退出");
    const initPayload = parseRpcPayload(initLine);
    if (initPayload?.error) return failed(initPayload.error.message ?? "initialize 被拒绝");
    if (!initPayload?.result) return failed("响应不是有效的 MCP initialize 结果");

    // 标准顺序：initialized 通知（无 id，server 不回）→ tools/list
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsLine = await readLine();
    if (toolsLine === null) return { state: "connected", tools: [] };
    return { state: "connected", tools: extractTools(parseRpcPayload(toolsLine)) };
  } catch (err) {
    return failed(errorMessage(err));
  } finally {
    clearTimeout(timer);
    cleanup();
    try {
      reader.releaseLock();
    } catch {
      /* 流已关闭 */
    }
  }
}

// ------------------------------------------------------------------- 入口

/**
 * 对单台 MCP server 做连通性探测。
 *
 * - `enabled: false` → `disabled`，不发起任何连接；
 * - http / streamable-http（有 url）→ POST initialize（401/403 → needs-auth）→ tools/list；
 * - stdio（有 command）→ spawn 子进程走换行分隔 JSON-RPC，结束即杀进程；
 * - type 缺省时按 url / command 推断；两者都缺 → failed。
 *
 * 单台总截止 `timeoutMs`（缺省 10s；列表批量探测传 3000）：到点就地判 failed，
 * 绝不拖住调用方——一台卡死只影响它自己。
 */
export async function probeMcpServer(
  config: McpServerConfig,
  opts: McpProbeOpts = {},
): Promise<McpProbeResult> {
  if (config.enabled === false) return { state: "disabled", tools: [] };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const agentDir = opts.agentDir ?? WA_PI_DIR;
  const deadline = Date.now() + timeoutMs;
  const type = config.type ?? (config.url ? "http" : config.command ? "stdio" : undefined);
  if (type === "http" || type === "streamable-http") {
    if (!config.url) return failed("配置缺少 url，无法探测");
    return probeHttp(config, deadline, agentDir);
  }
  if (type === "stdio") {
    if (!config.command) return failed("配置缺少 command，无法探测");
    return probeStdio(config, deadline, opts);
  }
  return failed("无法识别的传输类型（既无 url 也无 command）");
}
