// bridge-registry.ts — /bridge/tool 端点的分发核心：会话上下文注册表 + 进程级 token。
//
// pi 进程内的 wa-pi-bridge 扩展把工具调用 POST 到 kernel /bridge/tool，
// 本模块按 sessionId 找到 AgentManager（或测试）注册的 BridgeSessionContext 并分发执行。
// token 用于防本机其他进程伪造调用（bridge 端点只认 kernel spawn pi 时注入的 token）。
import { randomUUID } from "node:crypto";
import {
  KB_SEARCH_DIVERSITIES,
  KB_SEARCH_LIMIT_MAX,
  KB_SEARCH_MODES,
  KB_SEARCH_PROFILES,
  KB_SEARCH_WINDOW_MAX,
  type BridgeStreamFrame,
  type SubagentProgressEvent,
} from "@wa-pi/shared";
import { runAskTool } from "./ask-runner";
import { createMemoryTools, type MemoryToolContext } from "./memory/tools";
import type { KnowledgeSearchOptions, KnowledgeToolContext } from "./knowledge/tool";

/** 工具执行结果（与 pi AgentToolResult 对齐，经 HTTP 原样回传给扩展） */
export interface BridgeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  /** 工具内嵌 LLM 用量（delegate/fleet 子代理消耗）：pi 官方 stats 原生计入累计 */
  usage?: unknown;
}

/** 单个会话的宿主工具执行上下文（由 AgentManager 在会话启动时注册） */
export interface BridgeSessionContext {
  cwd: string;
  handleTool(
    tool: string,
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    /** 子代理进度回调（流式 bridge 用于向 NDJSON 流写 progress 帧） */
    onProgress?: (event: SubagentProgressEvent) => void,
  ): Promise<BridgeToolResult>;
}

const sessions = new Map<string, BridgeSessionContext>();

/** 注册会话的 bridge 上下文（同 sessionId 重复注册覆盖旧值） */
export function registerBridgeSession(
  sessionId: string,
  ctx: BridgeSessionContext,
): void {
  sessions.set(sessionId, ctx);
}

/** 注销会话的 bridge 上下文（会话 dispose 时调用）。幂等。 */
export function unregisterBridgeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** 查询会话的 bridge 上下文；未注册返回 undefined */
export function getBridgeSession(
  sessionId: string,
): BridgeSessionContext | undefined {
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
export async function handleBridgeRequest(
  body: unknown,
  signal?: AbortSignal,
): Promise<BridgeResponse> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const { token, sessionId, toolCallId, tool, params } = body as Record<
    string,
    unknown
  >;
  if (typeof token !== "string" || !verifyBridgeToken(token)) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  if (
    typeof sessionId !== "string" ||
    typeof toolCallId !== "string" ||
    typeof tool !== "string"
  ) {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const ctx = sessions.get(sessionId);
  if (!ctx) {
    return { ok: false, status: 404, error: "unknown_session" };
  }
  try {
    // signal 来自 HTTP 请求（ws-server 透传 req.signal）：客户端断连（如 pi 侧 bridge
    // 空闲超时 abort fetch）时服务端感知，ask 等阻塞工具据此作废 registry 条目，
    // 避免「条目仍在 pending、但已无人等待结果」的僵尸提问。缺省用永不 abort 的兜底。
    const result = await ctx.handleTool(
      tool,
      toolCallId,
      params,
      signal ?? new AbortController().signal,
    );
    return { ok: true, status: 200, result };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- 流式分支 ----

/** 流式工具集合（仅这些走 NDJSON 流式，其余走旧同步路径）。
 *  ask 也在内：等待用户回答期间服务端长时间不写数据，Bun idleTimeout（上限 255s）
 *  会提前掐断非流式连接（设计等待 600s 实际 ~255s 失效）；走流式后 15s 心跳保活。 */
const STREAM_TOOLS = new Set(["delegate", "fleet", "ask_user_question"]);

/** 判断工具是否走 NDJSON 流式分支（ws-server 路由与本模块共用，防两处字面量漂移） */
export function isBridgeStreamTool(tool: string): boolean {
  return STREAM_TOOLS.has(tool);
}

/**
 * 处理 POST /bridge/tool 的流式分支：
 * - delegate/fleet：经 write 回调输出 started→progress/ping(多帧)→final NDJSON 帧，返回 null
 * - 其他工具：走旧同步路径（复用 handleBridgeRequest），返回 BridgeResponse（由调用方 Response.json）
 *
 * write 签名：(ndjsonLine: string) => void，每帧是 JSON.stringify 后的字符串 + "\n"。
 * 返回 null 表示流式工具已自行 write，调用方不应再 Response.json；
 * 校验失败（token/body/session）仍返回 BridgeResponse，由调用方按状态码回 HTTP 错误。
 */
export async function handleBridgeStream(
  body: unknown,
  write: (ndjsonLine: string) => void,
  opts?: { heartbeatMs?: number; signal?: AbortSignal },
): Promise<BridgeResponse | null> {
  if (!body || typeof body !== "object")
    return { ok: false, status: 400, error: "invalid_body" };
  const { token, sessionId, toolCallId, tool, params } = body as Record<
    string,
    unknown
  >;
  if (typeof token !== "string" || !verifyBridgeToken(token)) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  if (
    typeof sessionId !== "string" ||
    typeof toolCallId !== "string" ||
    typeof tool !== "string"
  ) {
    return { ok: false, status: 400, error: "invalid_body" };
  }

  // 非流式工具：复用旧同步路径，返回结构化结果交回调用方走 JSON
  if (!STREAM_TOOLS.has(tool)) {
    return handleBridgeRequest(body);
  }

  const ctx = sessions.get(sessionId);
  if (!ctx) return { ok: false, status: 404, error: "unknown_session" };

  // 流式出口：把 BridgeStreamFrame 序列化成 NDJSON 一行写回调用方
  const emit = (frame: BridgeStreamFrame) =>
    write(JSON.stringify(frame) + "\n");
  emit({ type: "started", protocol: 1, tool, toolCallId });

  // 心跳：子代理长时间静默（长推理只产出 thinking、慢首 token、单个长工具调用）
  // 期间没有任何 progress 帧，若无心跳，pi 侧 bridge 的空闲超时（600s 无帧）会误杀
  // 仍在正常工作的子代理。周期写 ping 帧保活；ping 无业务含义，消费方忽略即可。
  const heartbeat = setInterval(
    () => emit({ type: "ping", tool, toolCallId }),
    opts?.heartbeatMs ?? 15_000,
  );

  try {
    // signal 来自 ws-server 流式分支：客户端断连（stream cancel）时 abort，
    // 级联中止正在执行的 delegate/fleet 子代理，防孤儿进程跑满 settle 超时、
    // 结果无人消费还持续烧 token。缺省用永不 abort 的兜底（测试/直调场景）。
    const result = await ctx.handleTool(
      tool,
      toolCallId,
      params,
      opts?.signal ?? new AbortController().signal,
      (e: SubagentProgressEvent) => {
        emit({ type: "progress", tool, toolCallId, progress: e });
      },
    );
    emit({ type: "final", tool, toolCallId, ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit({ type: "final", tool, toolCallId, ok: false, error });
  } finally {
    clearInterval(heartbeat);
  }
  return null; // 流式工具已自行 write，调用方不应再 Response.json
}

// ---- 默认宿主上下文工厂 ----

/**
 * 构造默认 BridgeSessionContext：ask 与 memory 直接复用现有宿主逻辑，
 * delegate/fleet 返回桩错误（宿主接线在后续任务完成）。
 *
 * - ask_user_question → runAskTool（ask-runner，与 SDK customTools 路径同一份实现）
 * - memory_* → createMemoryTools（memory/tools，SQLite DAO 后端）生成的对应工具的 execute
 * - knowledge_search → opts.knowledgeCtx.search（knowledge/tool 组装的闭包）；未注入即「未绑定」
 * - delegate / fleet → not_wired 桩
 */
export function makeDefaultBridgeContext(opts: {
  sessionId: string;
  cwd: string;
  memoryCtx: MemoryToolContext;
  /** 知识库检索上下文（agent-manager 组装）；未注入 = 未绑定任何库，工具返回友好提示 */
  knowledgeCtx?: KnowledgeToolContext;
}): BridgeSessionContext {
  // 松开 ToolDefinition 的 SDK 泛型：本文件不引用 pi SDK 类型，按结构化签名调用
  const memoryTools = createMemoryTools(opts.memoryCtx) as unknown as Array<{
    name: string;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<BridgeToolResult>;
  }>;
  return {
    cwd: opts.cwd,
    async handleTool(tool, toolCallId, params, signal) {
      if (tool === "ask_user_question") {
        return runAskTool(opts.sessionId, toolCallId, params, signal);
      }
      if (tool === "delegate" || tool === "fleet") {
        // 桩：delegate/fleet 的宿主接线在后续任务完成
        return {
          content: [{ type: "text", text: "delegate/fleet 尚未接入 bridge" }],
          details: { error: "not_wired" },
        };
      }
      const memTool = memoryTools.find((t) => t.name === tool);
      if (memTool) {
        return memTool.execute(toolCallId, params, signal);
      }
      if (tool === "knowledge_search") {
        return handleKnowledgeSearch(opts.knowledgeCtx, params);
      }
      return {
        content: [{ type: "text", text: `未知 bridge 工具: ${tool}` }],
        details: { error: "unknown_tool" },
      };
    },
  };
}

// knowledge_search 参数面的取值集合（真源在 shared/tool-schemas 的 KB_SEARCH_* 常量）
const KB_SEARCH_MODE_SET = new Set<string>(KB_SEARCH_MODES);
const KB_SEARCH_PROFILE_SET = new Set<string>(KB_SEARCH_PROFILES);
const KB_SEARCH_DIVERSITY_SET = new Set<string>(KB_SEARCH_DIVERSITIES);

/** 整数参数：非数字/非有限值视为未提供；否则截断并夹紧到 [min, max] */
function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** 枚举参数：trim + 小写归一后比对（取值全小写，归一安全）；集合外的值当未提供，回落默认策略 */
function enumParam(value: unknown, allowed: Set<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : undefined;
}

/** 字符串参数：缺省/空串视为未提供 */
function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * knowledge_search 分支：参数解析 → knowledgeCtx.search → snake_case 结构化输出
 * （字段名对齐 shared/tool-schemas 的 KB_SEARCH_DESCRIPTION 文案：
 * content / file_path / title / breadcrumb / lines / kb_name / score / stale，
 * 以及分页承诺 total_count / has_more 与 diagnostics=true 时的 tuning）。
 * 参数面直接对齐 KB_SEARCH_PARAMS_SCHEMA：mode 12 取值 / profile 8 取值 / 分页 /
 * 过滤 / 多样性 / 诊断全部原样下传（不在这里折叠 mode，也不替调用方补 limit，
 * 缺省值由 searchKnowledge 按 profile/env 决定）。
 * 未注入 knowledgeCtx（= 未绑定任何库）返回友好提示；query 空参数返回错误内容。
 */
async function handleKnowledgeSearch(
  knowledgeCtx: KnowledgeToolContext | undefined,
  params: unknown,
): Promise<BridgeToolResult> {
  if (!knowledgeCtx) {
    return {
      content: [
        {
          type: "text",
          text:
            "未绑定知识库：当前智能体没有绑定任何知识库，knowledge_search 不可用。" +
            "可在智能体设置中绑定知识库后重试。",
        },
      ],
      details: { error: "no_knowledge_base" },
    };
  }
  const raw = (params ?? {}) as Record<string, unknown>;
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query) {
    return {
      content: [
        {
          type: "text",
          text: "参数错误：query 不能为空，请提供要检索的短语或句子。",
        },
      ],
      details: { error: "invalid_params" },
    };
  }

  const opts: KnowledgeSearchOptions = {};
  const limit = clampInt(raw.limit, 1, KB_SEARCH_LIMIT_MAX);
  if (limit !== undefined) opts.limit = limit;
  const offset = clampInt(raw.offset, 0, KB_SEARCH_WINDOW_MAX - 1);
  if (offset !== undefined) {
    // 上游窗口规则：offset + limit ≤ 800（limit 缺省时其值由 profile 决定，上限只能夹到窗口边界）
    opts.offset =
      limit === undefined
        ? offset
        : Math.min(offset, KB_SEARCH_WINDOW_MAX - limit);
  }
  const mode = enumParam(raw.mode, KB_SEARCH_MODE_SET);
  if (mode) opts.mode = mode as KnowledgeSearchOptions["mode"];
  const profile = enumParam(raw.profile, KB_SEARCH_PROFILE_SET);
  if (profile) opts.profile = profile as KnowledgeSearchOptions["profile"];
  const kbId = stringParam(raw.kb_id);
  if (kbId) opts.kbId = kbId;
  const fileType = stringParam(raw.file_type);
  if (fileType) opts.fileType = fileType;
  const pathPattern = stringParam(raw.path_pattern);
  if (pathPattern) opts.pathPattern = pathPattern;
  const diversity = enumParam(raw.diversity, KB_SEARCH_DIVERSITY_SET);
  if (diversity) opts.diversity = diversity as KnowledgeSearchOptions["diversity"];
  if (typeof raw.diagnostics === "boolean") opts.diagnostics = raw.diagnostics;

  const res = await knowledgeCtx.search(query, opts);
  const skipped = res.skippedKbs.length
    ? res.skippedKbs.map((s) => `${s.kbId}(${s.reason})`).join(", ")
    : null;
  // 检索层 warnings（如 embedding 指纹不匹配导致向量通道禁用）必须能被模型看到，
  // 否则信息只落在没人读的字段里（与 skippedKbs 同等可观测）
  const warnings = res.warnings?.length ? res.warnings : null;
  const warningNote = warnings ? `（提示：${warnings.join("；")}）` : "";
  if (!res.found) {
    // offset 越过总数：是「这一页没内容」，不是「库里没内容」（offset 放开后才会出现）
    if ((opts.offset ?? 0) > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `本页已无更多结果（共 ${res.totalCount} 条，已翻到 offset ${opts.offset}）` +
              `${skipped ? `（跳过: ${skipped}）` : ""}。把 offset 设为 0 可从头重检。${warningNote}`,
          },
        ],
        details: {
          total_count: res.totalCount,
          has_more: res.hasMore,
          offset: opts.offset,
        },
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `知识库中未找到相关内容${skipped ? `（跳过: ${skipped}）` : ""}。空结果表示知识库未覆盖该内容，不代表事实不存在。${warningNote}`,
        },
      ],
    };
  }
  const text = JSON.stringify({
    results: res.results.map((h) => ({
      content: h.content,
      file_path: h.filePath,
      title: h.title,
      breadcrumb: h.breadcrumb,
      lines:
        h.startLine != null
          ? `${h.startLine}-${h.endLine ?? h.startLine}`
          : null,
      kb_name: h.kbName,
      score: Number(h.score.toFixed(4)),
      // 仅陈旧命中带该键：正常结果不加噪声；智能体见 stale 应提示重建索引/核对原文
      ...(h.stale ? { stale: true } : {}),
    })),
    skippedKbs: skipped,
    ...(warnings ? { warnings } : {}),
    mode: res.modeUsed,
    rerank_used: res.rerankUsed,
    // 分页承诺（offset 已放开）：模型靠这两项判断要不要继续翻页
    total_count: res.totalCount,
    has_more: res.hasMore,
    // diagnostics 开关的唯一可见效果（无命中时无排序诊断可报）
    ...(opts.diagnostics === true ? { tuning: res.tuning } : {}),
  });
  return { content: [{ type: "text", text }] };
}
