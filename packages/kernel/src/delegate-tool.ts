// delegate 关系网调起工具 + pi-subagents service 适配。
//
// LLM 经 delegate(agent, task) 调起 askTo 内的智能体：
// - allowlist 在宿主侧强制（扩展原生 subagent 工具不进 allowlist，见 constants.resolveAgentTools）。
// - 越权调起返回错误文本，不触碰 service。
// - 合法调起经 spawn 闭包执行：pi-subagents 的 svc.spawn 同步返回 agent ID（不是结果），
//   结果靠 getRecord(id) 轮询到终态后映射（见 waitSubagentResult）。
//
// 错误语义：execute 返回值带 isError 标记。SDK 层（pi-agent-core）目前不把
// result.isError 透传到 ToolResultMessage（仅 execute 抛异常才标 isError），
// 错误信息经文本传达给 LLM——与 pi-subagents 原生 subagent 工具先例一致
//（其所有错误路径均返回普通文本）。
import { Type } from "typebox";

export interface DelegateTarget {
  name: string;
  description: string;
}

/** spawn 闭包返回值：text 给 LLM，isError 标记失败（服务未就绪/调起异常/子智能体失败/超时/中止） */
export interface DelegateSpawnResult {
  text: string;
  isError: boolean;
}

export type DelegateSpawnFn = (agent: string, task: string) => Promise<DelegateSpawnResult>;

const DelegateParamsSchema = Type.Object({
  agent: Type.String({ description: "可调起列表中的智能体名称" }),
  task: Type.String({ description: "交给子智能体的任务描述" }),
});

/** 构造 delegate 工具（闭包绑 askTo + spawn）。每个 session 一份实例，askTo 非空时才注册。 */
export function makeDelegateTool(opts: {
  askTo: DelegateTarget[];
  spawn: DelegateSpawnFn;
}) {
  return {
    name: "delegate",
    label: "Delegate",
    description: "调起关系网内的子智能体执行任务并返回结果。agent 必须取可调起列表中的智能体名称。",
    parameters: DelegateParamsSchema,
    async execute(
      _toolCallId: string,
      args: { agent: string; task: string },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError: boolean }> {
      if (!opts.askTo.some((t) => t.name === args.agent)) {
        const allow = opts.askTo.map((t) => t.name).join("、") || "（空）";
        return {
          content: [{ type: "text" as const, text: `错误：智能体「${args.agent}」不在可调起列表中。可调起：${allow}` }],
          details: undefined,
          isError: true,
        };
      }
      const { text, isError } = await opts.spawn(args.agent, args.task);
      return { content: [{ type: "text" as const, text }], details: undefined, isError };
    },
  };
}

/** 关系网提示词段：列出可调起智能体（名称/简介/触发关键词）。askTo 为空返回空串（不注入）。 */
export function buildDelegatePrompt(
  askTo: { name: string; description: string; triggerKeywords: string[] }[],
): string {
  if (askTo.length === 0) return "";
  const lines = askTo.map((t) => {
    const kw = t.triggerKeywords.length ? `；触发关键词：${t.triggerKeywords.join("、")}` : "";
    return `- ${t.name}：${t.description || "（无简介）"}${kw}`;
  });
  return [
    "你可以通过 delegate 工具（参数 agent、task）调起以下智能体协作：",
    ...lines,
    "当用户消息涉及某智能体的触发关键词或其简介描述的话题时，优先调起对应智能体；只能调起列表内的智能体。",
  ].join("\n");
}

/** pi-subagents SubagentsService 的最小结构子集（轮询 + 中止），便于单测注入 mock */
export interface SubagentServiceLike {
  getRecord(id: string): { status: string; result?: string; error?: string } | undefined;
  abort(id: string): boolean;
}

// 中止类终态：与用户/系统主动打断区分于 error（执行失败）
const ABORTED_STATUSES = new Set(["aborted", "stopped", "steered"]);

/**
 * 轮询 svc.getRecord(id) 直到终态并映射为 DelegateSpawnResult。
 * - completed → result（无输出兜底文本），isError:false
 * - error → error 字段（兜底文本），isError:true
 * - aborted/stopped/steered → 中止文本，isError:true
 * - 超时 → 先 abort(id) 再返回超时文本，isError:true
 * - queued/running/record 缺失 → 继续轮询
 * 不用事件订阅、不用 waitForAll（它会等所有并发 agent）。
 */
export async function waitSubagentResult(
  svc: SubagentServiceLike,
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<DelegateSpawnResult> {
  const intervalMs = opts.intervalMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = svc.getRecord(id);
    if (record) {
      if (record.status === "completed") {
        return { text: record.result ?? "（子智能体无输出）", isError: false };
      }
      if (record.status === "error") {
        return { text: record.error ?? "子智能体执行失败", isError: true };
      }
      if (ABORTED_STATUSES.has(record.status)) {
        return { text: "子智能体被中止", isError: true };
      }
    }
    if (Date.now() >= deadline) {
      svc.abort(id);
      return { text: "子智能体执行超时（10 分钟）", isError: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 生产 spawn 闭包：动态 import pi-subagents service（进程内单例，由内置扩展发布）→
 * spawn（无活动会话会 throw，catch 收敛为错误文本）→ waitSubagentResult 轮询。
 * 所有失败路径收敛为 { text, isError:true }，绝不 throw 中断会话。
 */
export async function spawnViaSubagentsService(agent: string, task: string): Promise<DelegateSpawnResult> {
  const { getSubagentsService } = await import("@gotgenes/pi-subagents");
  const svc = getSubagentsService();
  if (!svc) return { text: "子智能体服务未就绪", isError: true };
  let id: string;
  try {
    id = svc.spawn(agent, task);
  } catch (err) {
    return { text: `子智能体调起失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  return waitSubagentResult(svc, id);
}
