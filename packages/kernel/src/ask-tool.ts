// ask_user_question 工具定义 + 重启兜底。
//
// makeAskTool(sessionId) 闭包注入 wa-pi sessionId（execute 签名无 sessionId），
// 返回 pi ToolDefinition 形状的普通对象（defineTool 只是恒等函数，不依赖 SDK import）。
// 生产路径：schema 由 wa-pi-bridge 扩展注册（bridge-extension.ts 复制本文件 schema）；
// execute 本体在 ask-runner.ts（runAskTool），bridge 与测试共用。
import {
  ASK_DESCRIPTION,
  ASK_PROMPT_GUIDELINES,
  AskParamsSchema,
} from "@wa-pi/shared";
import { runAskTool, type AskToolDetails } from "./ask-runner";

// 兼容旧引用方：AskToolDetails 已移至 ask-runner.ts（与 bridge 共用的无 SDK 实现）
export type { AskToolDetails } from "./ask-runner";

/** 构造 ask_user_question 工具（闭包绑 sessionId）。每个 session 一份实例。 */
export function makeAskTool(sessionId: string) {
  // defineTool 在 pi 里是恒等函数，直接返回普通对象即可（不 import SDK）
  return {
    name: "ask_user_question",
    label: "Ask User",
    description: ASK_DESCRIPTION,
    promptGuidelines: ASK_PROMPT_GUIDELINES,
    parameters: AskParamsSchema,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: AskToolDetails;
    }> {
      // signal 在 ToolDefinition.execute 签名里是 AbortSignal | undefined；
      // runAskTool 需要 AbortSignal，undefined 时用永不 abort 的 controller 兜底。
      const safeSignal = signal ?? new AbortController().signal;
      return runAskTool(sessionId, toolCallId, params, safeSignal);
    },
  };
}

/**
 * 重启兜底：扫描 session 历史，对「无 toolResult 的 ask_user_question 工具调用」
 * 注入一条 cancelled toolResult，避免 agent 卡在等结果。返回新数组（不改入参）。
 * 注：内核重启后 registry 内存态丢失，pending 提问无法恢复交互式 UI；此函数让 agent
 * 看到「用户取消」从而能自行重问，保证会话不卡死。
 *
 * @param opts.isSessionActive 当 session 仍在活跃运行（agent 正在等待回答）时，
 *   跳过对账——此时 ask 仍在 askRegistry 中 pending，不应误判为「重启后残留」。
 */
export function reconcileDanglingAsks(messages: ReadonlyArray<unknown>, opts?: { isSessionActive?: boolean }): unknown[] {
  // session 仍在活跃运行：ask 在 registry 中等待用户回答，不是「重启后残留」
  if (opts?.isSessionActive) return [...messages];
  const msgs = messages as Array<Record<string, unknown>>;
  const answered = new Set<string>();
  for (const m of msgs) {
    if (m.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }
  const dangling: Array<Record<string, unknown>> = [];
  let ts = 0;
  for (const m of msgs) ts = Math.max(ts, (m.timestamp as number) ?? 0);
  for (const m of msgs) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === "toolCall" && b.name === "ask_user_question" && typeof b.id === "string" && !answered.has(b.id)) {
        answered.add(b.id);
        dangling.push({
          role: "toolResult",
          toolCallId: b.id,
          toolName: "ask_user_question",
          content: [{ type: "text", text: "用户取消（会话重启）" }],
          isError: false,
          timestamp: ++ts,
        });
      }
    }
  }
  return dangling.length === 0 ? [...msgs] : [...msgs, ...dangling];
}
