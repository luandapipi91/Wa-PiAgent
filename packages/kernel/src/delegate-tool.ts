// delegate 关系网调起工具 + pi-open-agents runSubagent 适配。
//
// LLM 经 delegate(agent, task) 调起 askTo 内的智能体：
// - allowlist 在宿主侧强制（扩展原生 subagent 工具不进 allowlist，见 constants.resolveAgentTools）。
// - 越权调起返回错误文本，不触碰 service。
// - 合法调起经 spawn 闭包执行：pi-open-agents 的 runSubagent（子进程 async），
//   由 subagent-runner 适配层封装。
//
// 错误语义：execute 返回值带 isError 标记。SDK 层（pi-agent-core）目前不把
// result.isError 透传到 ToolResultMessage（仅 execute 抛异常才标 isError），
// 错误信息经文本传达给 LLM——与原生 subagent 工具先例一致
//（其所有错误路径均返回普通文本）。
import { Type } from "typebox";
import { isSubagentType, SUBAGENT_TYPES, normalizeSubagentType } from "@hiagent/shared";
import type { HiAgentSpawnConfig, SubagentProgressEvent } from "./subagent-runner";
import { runSubagentAgent } from "./subagent-runner";

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
  agent: Type.String({ description: "可调起列表中的智能体名称，或内置 subagent 类型名（general-purpose / Explore / Plan）" }),
  task: Type.String({ description: "交给子智能体的任务描述" }),
});

/**
 * 判断 agent 名是否允许调起：在 askTo 名单内，或者是内置 subagent 类型名。
 * 内置类型（general-purpose / Explore / Plan）走 pi-open-agents 的 AgentDefinition，
 * 不在 HiAgent 的 askTo 关系网里——任何主智能体都可调起。
 */
function canInvoke(agent: string, askTo: DelegateTarget[]): boolean {
  return askTo.some(t => t.name === agent) || isSubagentType(agent);
}

/** 构造"可调起名单"错误文案：实名列表 + 内置类型提示 */
function buildNotAllowedMessage(agent: string, askTo: DelegateTarget[]): string {
  const names = askTo.map(t => t.name).join("、") || "（空）";
  const builtin = SUBAGENT_TYPES.map(t => t.name).join("、");
  return `错误：智能体「${agent}」不在可调起列表中。可调起：${names}；内置 subagent 类型：${builtin}`;
}

/** 构造 delegate 工具（闭包绑 askTo + spawn）。每个 session 一份实例，始终注册（内置类型不依赖 askTo）。 */
export function makeDelegateTool(opts: {
  askTo: DelegateTarget[];
  spawn: DelegateSpawnFn;
}) {
  return {
    name: "delegate",
    label: "Delegate",
    description: "调起子智能体执行任务并返回结果。agent 可以是关系网内的智能体名称，或内置 subagent 类型名（general-purpose / Explore / Plan）。",
    parameters: DelegateParamsSchema,
    async execute(
      _toolCallId: string,
      args: { agent: string; task: string },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; isError: boolean }> {
      if (!canInvoke(args.agent, opts.askTo)) {
        return {
          content: [{ type: "text" as const, text: buildNotAllowedMessage(args.agent, opts.askTo) }],
          details: undefined,
          isError: true,
        };
      }
      // 内置 subagent 中文别名（如"通用子智能体"）归一化为英文 name（"general-purpose"），
      // 让 spawn 闭包传给 subagent-runner 时能正确匹配 AgentDefinition
      const spawnAgent = normalizeSubagentType(args.agent);
      const { text, isError } = await opts.spawn(spawnAgent, args.task);
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

/**
 * spawn 闭包工厂：绑定 HiAgent config + cwd + 过程回调，
 * 调用 subagent-runner 的 runSubagentAgent 执行子智能体。
 *
 * resolveConfig 由 agent-manager 从 AgentConfig 提取（name/description/systemPrompt/model/thinking/tools/skills）。
 * onProgress 回调实时转发子智能体执行过程（工具调用/文本输出），用于前端过程展示。
 */
export function makeSpawnFn(opts: {
  resolveConfig: (agentName: string) => Promise<HiAgentSpawnConfig | null>;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (event: SubagentProgressEvent) => void;
}): DelegateSpawnFn {
  return async (agent: string, task: string) => {
    const config = await opts.resolveConfig(agent);
    if (!config) {
      return { text: `智能体「${agent}」配置未找到`, isError: true };
    }
    return runSubagentAgent(config, task, opts.cwd, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  };
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
          if (!canInvoke(t.agent, opts.askTo)) {
            return { agent: t.agent, text: buildNotAllowedMessage(t.agent, opts.askTo), isError: true };
          }
          // 内置 subagent 中文别名归一化（同 delegate 单任务路径）
          const spawnAgent = normalizeSubagentType(t.agent);
          const { text, isError } = await opts.spawn(spawnAgent, t.task);
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
