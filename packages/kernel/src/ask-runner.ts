// ask-runner.ts — ask_user_question 的执行逻辑（校验 + 阻塞等回答 + 结果组装）。
//
// 从 ask-tool.ts 提取为可复用函数：SDK customTools 路径（makeAskTool）与
// RPC bridge 路径（bridge-registry 的 makeDefaultBridgeContext）共用同一份实现，
// 避免两份逻辑漂移。本文件不依赖 pi SDK，可在 RPC 架构下直接引用。
import { askRegistry } from "./ask-registry";
import { validateAskParams, type AskParams, type AskAnswer } from "@wa-pi/shared";

export interface AskToolDetails {
  answers?: AskAnswer[];
  cancelled: boolean;
  error?: string;
}

/**
 * 执行一次 ask_user_question：先校验（非法直接返回 details.error，不阻塞），
 * 否则 await askRegistry.ask(...) 阻塞到用户回答/取消/中断，再拼装文本结果。
 */
export async function runAskTool(
  sessionId: string,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: AskToolDetails }> {
  const error = validateAskParams(params);
  if (error) {
    return { content: [{ type: "text", text: `ask 校验失败: ${error}` }], details: { cancelled: false, error } };
  }
  const outcome = await askRegistry.ask(sessionId, toolCallId, params as AskParams, signal);
  if (outcome.cancelled) {
    return { content: [{ type: "text", text: "用户取消了提问" }], details: { cancelled: true } };
  }
  const text = (outcome.answers ?? [])
    .map((a) => `Q: ${a.question}\nA: ${a.kind === "multi" ? (a.selected?.join(", ") ?? "") : (a.answer ?? "")}${a.notes ? ` (备注: ${a.notes})` : ""}`)
    .join("\n\n");
  return { content: [{ type: "text", text }], details: { cancelled: false, answers: outcome.answers } };
}
