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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** fleet 并发上限（参考 DeepSeek-Reasonix / pi-dynamic-workflows 默认值） */
export const MAX_SUBAGENT_CONCURRENCY = 6;

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
    "当多个独立的子任务可以并行执行时，使用 fleet 工具（参数 tasks: [{agent, task}]）一次性派发，并发上限 6；fleet 适合 codebase-wide audit、多文件并行处理等场景，每个 task 仍按任务合约范式组织。",
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
 * - running 且 record 存在 → 动态续期：每次见到 running 重置 activeDeadline
 * - activeDeadline 超时（无进展）→ 继续轮询（不 abort，子智能体可能还在工作）
 * - hardDeadline 超时（绝对上限）→ abort(id) 再返回超时文本，isError:true
 * - queued/record 缺失 → 继续轮询（不续期，因 record 不存在可能尚未启动）
 * 不用事件订阅、不用 waitForAll（它会等所有并发 agent）。
 */
export async function waitSubagentResult(
  svc: SubagentServiceLike,
  id: string,
  opts: { intervalMs?: number; activeTimeoutMs?: number; hardDeadlineMs?: number } = {},
): Promise<DelegateSpawnResult> {
  const intervalMs = opts.intervalMs ?? 500;
  const activeTimeoutMs = opts.activeTimeoutMs ?? 60_000;   // 默认 60s 无 running 续期则视为停滞
  const hardDeadlineMs = opts.hardDeadlineMs ?? 1_800_000;  // 默认绝对上限 30 分钟
  const hardDeadline = Date.now() + hardDeadlineMs;
  let activeDeadline = Date.now() + activeTimeoutMs;
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
      // running 且 record 存在 → 续期
      if (record.status === "running") {
        activeDeadline = Date.now() + activeTimeoutMs;
      }
    }
    if (Date.now() >= hardDeadline) {
      svc.abort(id);
      return { text: `子智能体执行超时（绝对上限 ${Math.round(hardDeadlineMs / 60000)} 分钟）`, isError: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 最小 ExtensionAPI 桩，用于手动加载扩展入口时防止 default export 抛错 */
function createExtensionApiStub() {
  return {
    registerMessageRenderer: () => {},
    sendMessage: async () => {},
    on: () => {},
    dispose: () => {},
    get settings() { return { get() { return undefined; }, set() {} }; },
  };
}

/**
 * 生产 spawn 闭包：动态 import pi-subagents service（进程内单例，由内置扩展发布）→
 * spawn（无活动会话会 throw，catch 收敛为错误文本）→ waitSubagentResult 轮询。
 * 所有失败路径收敛为 { text, isError:true }，绝不 throw 中断会话。
 */
export async function spawnViaSubagentsService(
  agent: string,
  task: string,
  opts?: { intervalMs?: number; activeTimeoutMs?: number; hardDeadlineMs?: number },
): Promise<DelegateSpawnResult> {
  const mod = await import("@gotgenes/pi-subagents");
  let svc = mod.getSubagentsService();
  // 兜底：Pi SDK 未加载扩展入口 → 手动导入并调用 default export
  if (!svc) {
    console.log("[delegate] getSubagentsService 未就绪，尝试手动加载扩展入口...");
    try {
      const req = createRequire(import.meta.url);
      const pkgRoot = dirname(req.resolve("@gotgenes/pi-subagents/package.json"));
      const indexTs = join(pkgRoot, "src", "index.ts");
      console.log("[delegate] 扩展入口路径:", indexTs);
      const modExt = await import(indexTs);
      if (typeof modExt.default === "function") {
        console.log("[delegate] 扩展入口 default export 找到，调用中...");
        try {
          await modExt.default(createExtensionApiStub());
          svc = mod.getSubagentsService();
          console.log("[delegate] 手动加载后 getSubagentsService() =>", svc ? "已就绪" : "仍 undefined");
        } catch (e) {
          console.log("[delegate] 扩展入口 default export 抛错:", e);
        }
      } else {
        console.log("[delegate] 扩展入口无 default export, typeof:", typeof modExt.default);
      }
    } catch (e) {
      console.log("[delegate] 手动加载扩展入口失败:", e);
    }
  }
  if (!svc) return { text: "子智能体服务未就绪", isError: true };
  let id: string;
  try {
    id = svc.spawn(agent, task);
  } catch (err) {
    return { text: `子智能体调起失败: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  return waitSubagentResult(svc, id, opts);
}

const FleetParamsSchema = Type.Object({
  tasks: Type.Array(Type.Object({
    agent: Type.String({ description: "可调起列表中的智能体名称" }),
    task: Type.String({ description: "交给该子智能体的任务描述（按任务合约范式组织）" }),
  })),
});

/** 简易并发限制器：按 limit 并发执行 thunks，结果按输入顺序返回 */
async function runWithConcurrency<T>(
  thunks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (cursor < thunks.length) {
      const i = cursor++;
      results[i] = await thunks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** 构造 fleet 工具：并行派发多个 delegate 任务，按输入顺序聚合结果 */
export function makeFleetTool(opts: {
  askTo: DelegateTarget[];
  spawn: DelegateSpawnFn;
}) {
  return {
    name: "fleet",
    label: "Fleet",
    description: "并行调起多个子智能体执行任务并聚合结果。每个 agent 必须取可调起列表中的智能体名称。适用于多个独立子任务可并行的场景。",
    parameters: FleetParamsSchema,
    async execute(
      _toolCallId: string,
      args: { tasks: Array<{ agent: string; task: string }> },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError: boolean }> {
      if (args.tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "无任务" }],
          details: undefined,
          isError: false,
        };
      }
      const results = await runWithConcurrency(
        args.tasks.map(t => async () => {
          if (!opts.askTo.some(x => x.name === t.agent)) {
            const allow = opts.askTo.map(x => x.name).join("、") || "（空）";
            return { agent: t.agent, text: `错误：智能体「${t.agent}」不在可调起列表中。可调起：${allow}`, isError: true };
          }
          const { text, isError } = await opts.spawn(t.agent, t.task);
          return { agent: t.agent, text, isError };
        }),
        MAX_SUBAGENT_CONCURRENCY,
      );
      // 按输入顺序聚合为单段文本
      const lines = results.map(r => `【${r.agent}】${r.isError ? "（失败）" : ""}\n${r.text}`);
      const anyError = results.some(r => r.isError);
      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
        details: undefined,
        isError: anyError,
      };
    },
  };
}
