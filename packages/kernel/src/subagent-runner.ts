// subagent-runner.ts — pi-open-agents runSubagent 适配层
//
// 职责：
// 1. buildAgentDefinition：从 HiAgent AgentConfig 构造 pi-open-agents 的 AgentDefinition
//    - 内置类型（general-purpose/Explore/Plan）用 SUBAGENT_TYPES 元信息补全缺省值
//    - config.skills/tools 白名单映射到 AgentDefinition（空=undefined 即继承全部）
// 2. runSubagentAgent：调用 pi-open-agents runSubagent（子进程 async）
//    - onProgress 回调实时转发工具调用/文本输出/用量（供前端过程展示）
//    - 所有失败路径收敛为 { text, isError:true }，绝不 throw

import { runSubagent } from "pi-open-agents";
import type { AgentDefinition, AgentProgress, AgentResult } from "pi-open-agents";
import type { ThinkingLevel } from "@hiagent/shared";
import { SUBAGENT_TYPES, isSubagentType } from "@hiagent/shared";

/** HiAgent 侧的 agent 配置片段（从 AgentConfig 提取） */
export interface HiAgentSpawnConfig {
  name: string;
  description: string;
  systemPrompt: string;
  systemPromptMode: "replace" | "append";
  model: string | null;
  thinking: ThinkingLevel | null;
  tools: string[];
  skills: string[];
}

/** 过程事件：转发给 agent-manager → WS → 前端 */
export interface SubagentProgressEvent {
  agent: string;
  status: "running" | "done" | "error";
  output: string;
  tools: Array<{ id: string; name: string; status: string }>;
  elapsedMs: number;
}

/** 执行结果（与 delegate-tool 的 DelegateSpawnResult 对齐） */
export interface SubagentRunResult {
  text: string;
  isError: boolean;
}

/** thinking → pi-open-agents thinkingLevel 映射 */
function mapThinking(thinking: ThinkingLevel | null): string {
  if (!thinking) return "medium";
  return thinking === "disabled" ? "off"
    : thinking === "max" ? "xhigh"
    : thinking;
}

/**
 * 从 HiAgent config 构造 pi-open-agents 的 AgentDefinition。
 * 内置 subagent 类型（general-purpose/Explore/Plan）用 SUBAGENT_TYPES 元信息补全。
 *
 * config.skills / config.tools 白名单在此映射到 AgentDefinition：
 * - 非空数组 = 按白名单限定（pi-open-agents 支持通配符）
 * - 空数组 = undefined（不设字段 = 继承全部，pi-open-agents 默认行为）
 */
export function buildAgentDefinition(config: HiAgentSpawnConfig): AgentDefinition {
  // 内置类型从 SUBAGENT_TYPES 补全工具/提示词缺省值
  const builtin = isSubagentType(config.name)
    ? SUBAGENT_TYPES.find(t => t.name === config.name)
    : undefined;

  const tools = config.tools.length > 0
    ? config.tools
    : builtin?.readOnly
      ? ["read", "bash", "grep", "find", "ls"]
      : undefined; // undefined = 全量工具（不设 tools 字段）

  // skills：非空数组 = 白名单限定；空数组 = undefined（继承全部）
  const skills = config.skills.length > 0 ? config.skills : undefined;

  return {
    name: config.name,
    description: config.description || builtin?.description || "",
    mode: "subagent",
    hidden: false,
    disable: false,
    model: config.model ?? undefined,
    thinking: mapThinking(config.thinking) as AgentDefinition["thinking"],
    systemPrompt: config.systemPromptMode,
    prompt: config.systemPrompt,
    tools,
    skills,
    maxDepth: 3,
    filePath: "",
    source: "project",
  } as AgentDefinition;
}

/**
 * 执行子智能体：调用 pi-open-agents runSubagent（子进程）。
 * onProgress 回调实时转发工具调用/文本输出/用量。
 * 所有失败路径收敛为 { text, isError:true }，绝不 throw。
 */
export async function runSubagentAgent(
  config: HiAgentSpawnConfig,
  task: string,
  cwd: string,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (event: SubagentProgressEvent) => void;
  },
): Promise<SubagentRunResult> {
  const agentDef = buildAgentDefinition(config);

  try {
    const result: AgentResult = await runSubagent({
      agent: agentDef,
      task,
      cwd,
      signal: opts?.signal,
      onProgress: opts?.onProgress
        ? (progress: AgentProgress) => {
            opts.onProgress!({
              agent: progress.agent,
              status: progress.status,
              output: progress.output,
              tools: progress.tools.map(t => ({ id: t.id, name: t.name, status: t.status })),
              elapsedMs: progress.elapsedMs,
            });
          }
        : undefined,
    });

    return {
      text: result.output || "（子智能体无输出）",
      isError: result.isError,
    };
  } catch (err) {
    return {
      text: `子智能体执行失败: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
