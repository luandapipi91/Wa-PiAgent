// ask_user_question 工具定义 + 重启兜底。
//
// makeAskTool(sessionId) 闭包注入 hiagent sessionId（execute 签名无 sessionId），
// 返回 SDK ToolDefinition，交给 createAgentSession({ customTools })。
// execute：先校验（非法直接返回 details.error，不阻塞），否则 await askRegistry.ask(...)。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askRegistry } from "./ask-registry";
import { validateAskParams, type AskParams, type AskAnswer } from "@hiagent/shared";

const AskParamsSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "完整问题文本，以 ? 结尾" }),
      header: Type.String({ description: "chip 标签文字，≤16 字符" }),
      multiSelect: Type.Optional(Type.Boolean({ description: "是否多选，默认 false" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "1-5 词，≤60 字符" }),
          description: Type.String({ description: "解释该选项/取舍" }),
          preview: Type.Optional(Type.String({ description: "可选 markdown，随选项展示" })),
        }),
        { minItems: 2, maxItems: 4 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

export interface AskToolDetails {
  answers?: AskAnswer[];
  cancelled: boolean;
  error?: string;
}

/** 构造 ask_user_question 工具（闭包绑 sessionId）。每个 session 一份实例。 */
export function makeAskTool(sessionId: string) {
  return defineTool({
    name: "ask_user_question",
    label: "Ask User",
    description:
      "向用户提出 1-4 个结构化澄清问题（每问 2-4 个选项），代替瞎猜。每个问题可单选或多选；" +
      "用户可填「其他」自由文本或取消。返回 details.answers（含 kind: option|custom|multi）或 cancelled。",
    promptGuidelines: [
      "当存在会显著改变实现的歧义、且不值得自己合理假设时再用；一次问最少必要的问题；",
      "选项文案简洁，给出取舍说明；不要用于确认显而易见的事。",
    ],
    parameters: AskParamsSchema,
    async execute(toolCallId, params, signal): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: AskToolDetails;
    }> {
      const error = validateAskParams(params);
      if (error) {
        return { content: [{ type: "text", text: `ask 校验失败: ${error}` }], details: { cancelled: false, error } };
      }
      // signal 在 ToolDefinition.execute 签名里是 AbortSignal | undefined；
      // askRegistry.ask 需要 AbortSignal，undefined 时用永不 abort 的 controller 兜底。
      const safeSignal = signal ?? new AbortController().signal;
      const outcome = await askRegistry.ask(sessionId, toolCallId, params as AskParams, safeSignal);
      if (outcome.cancelled) {
        return { content: [{ type: "text", text: "用户取消了提问" }], details: { cancelled: true } };
      }
      const text = (outcome.answers ?? [])
        .map((a) => `Q: ${a.question}\nA: ${a.kind === "multi" ? (a.selected?.join(", ") ?? "") : (a.answer ?? "")}${a.notes ? ` (备注: ${a.notes})` : ""}`)
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { cancelled: false, answers: outcome.answers } };
    },
  });
}

/**
 * 重启兜底：扫描 session 历史，对「无 toolResult 的 ask_user_question 工具调用」
 * 注入一条 cancelled toolResult，避免 agent 卡在等结果。返回新数组（不改入参）。
 * 注：内核重启后 registry 内存态丢失，pending 提问无法恢复交互式 UI；此函数让 agent
 * 看到「用户取消」从而能自行重问，保证会话不卡死。
 */
export function reconcileDanglingAsks(messages: ReadonlyArray<unknown>): unknown[] {
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
