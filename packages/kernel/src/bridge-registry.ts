// bridge-registry.ts — /bridge/tool 端点的分发核心：会话上下文注册表 + 进程级 token。
//
// pi 进程内的 wa-pi-bridge 扩展把工具调用 POST 到 kernel /bridge/tool，
// 本模块按 sessionId 找到 AgentManager（或测试）注册的 BridgeSessionContext 并分发执行。
// token 用于防本机其他进程伪造调用（bridge 端点只认 kernel spawn pi 时注入的 token）。
import { randomUUID } from "node:crypto";
import { runAskTool } from "./ask-runner";
import { createAgentMemoryTools, type AmasterStore } from "./amaster-memory";

/** 工具执行结果（与 pi AgentToolResult 对齐，经 HTTP 原样回传给扩展） */
export interface BridgeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

/** 单个会话的宿主工具执行上下文（由 AgentManager 在会话启动时注册） */
export interface BridgeSessionContext {
  cwd: string;
  handleTool(tool: string, toolCallId: string, params: unknown, signal: AbortSignal): Promise<BridgeToolResult>;
}

const sessions = new Map<string, BridgeSessionContext>();

/** 注册会话的 bridge 上下文（同 sessionId 重复注册覆盖旧值） */
export function registerBridgeSession(sessionId: string, ctx: BridgeSessionContext): void {
  sessions.set(sessionId, ctx);
}

/** 注销会话的 bridge 上下文（会话 dispose 时调用）。幂等。 */
export function unregisterBridgeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** 查询会话的 bridge 上下文；未注册返回 undefined */
export function getBridgeSession(sessionId: string): BridgeSessionContext | undefined {
  return sessions.get(sessionId);
}

// ---- token 管理 ----

let bridgeToken: string | null = null;

/** 进程级随机 token（惰性生成一次）：kernel spawn pi 时经 WA_PI_BRIDGE_TOKEN 注入 */
export function getBridgeToken(): string {
  if (!bridgeToken) bridgeToken = randomUUID();
  return bridgeToken;
}

/** 校验请求方携带的 token 是否为本进程 token */
export function verifyBridgeToken(token: string): boolean {
  return token === getBridgeToken();
}

// ---- 请求分发 ----

export type BridgeResponse =
  | { ok: true; status: 200; result: BridgeToolResult }
  | { ok: false; status: number; error: string };

/**
 * 处理 POST /bridge/tool 的 JSON body：
 * { token, sessionId, toolCallId, tool, params } → 校验 → ctx.handleTool。
 * 校验失败/未注册返回结构化错误（由 ws-server 翻译成 HTTP 状态码）。
 */
export async function handleBridgeRequest(body: unknown): Promise<BridgeResponse> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const { token, sessionId, toolCallId, tool, params } = body as Record<string, unknown>;
  if (typeof token !== "string" || !verifyBridgeToken(token)) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  if (typeof sessionId !== "string" || typeof toolCallId !== "string" || typeof tool !== "string") {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const ctx = sessions.get(sessionId);
  if (!ctx) {
    return { ok: false, status: 404, error: "unknown_session" };
  }
  try {
    const result = await ctx.handleTool(tool, toolCallId, params, new AbortController().signal);
    return { ok: true, status: 200, result };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- 默认宿主上下文工厂 ----

/**
 * 构造默认 BridgeSessionContext：ask 与 memory 直接复用现有宿主逻辑，
 * delegate/fleet 返回桩错误（宿主接线在后续任务完成）。
 *
 * - ask_user_question → runAskTool（ask-runner，与 SDK customTools 路径同一份实现）
 * - memory_* → createAgentMemoryTools 生成的对应工具的 execute
 * - delegate / fleet → not_wired 桩
 */
export function makeDefaultBridgeContext(opts: {
  sessionId: string;
  cwd: string;
  memoryStores: { global: AmasterStore; project: AmasterStore };
}): BridgeSessionContext {
  // 松开 ToolDefinition 的 SDK 泛型：本文件不引用 pi SDK 类型，按结构化签名调用
  const memoryTools = createAgentMemoryTools(opts.memoryStores.global, opts.memoryStores.project) as unknown as Array<{
    name: string;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<BridgeToolResult>;
  }>;
  return {
    cwd: opts.cwd,
    async handleTool(tool, toolCallId, params, signal) {
      if (tool === "ask_user_question") {
        return runAskTool(opts.sessionId, toolCallId, params, signal);
      }
      if (tool === "delegate" || tool === "fleet") {
        // 桩：delegate/fleet 的宿主接线在后续任务完成
        return { content: [{ type: "text", text: "delegate/fleet 尚未接入 bridge" }], details: { error: "not_wired" } };
      }
      const memTool = memoryTools.find((t) => t.name === tool);
      if (memTool) {
        return memTool.execute(toolCallId, params, signal);
      }
      return { content: [{ type: "text", text: `未知 bridge 工具: ${tool}` }], details: { error: "unknown_tool" } };
    },
  };
}
