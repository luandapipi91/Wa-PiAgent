// WaPi 结构化问答：类型 + 纯校验/翻译。
// schema/返回对齐 @juicesharp/rpiv-ask-user-question，但仅作协议参考，不安装其 TUI。

/** 单个选项。label 为回传标识；description 给用户看；preview 为可选 markdown。 */
export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

/** 一个问题。multiSelect 默认 false（单选）。 */
export interface AskQuestion {
  question: string;
  header: string;          // chip 标签，≤16 字符
  options: AskOption[];    // 2-4 个
  multiSelect?: boolean;
}

/** 工具入参 = toolCall.arguments。 */
export interface AskParams {
  questions: AskQuestion[]; // 1-4 个
}

/** 工具返回里 details.answers 的单项。 */
export interface AskAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];      // multi 时存在
  notes?: string;           // per-question 备注
  preview?: string;
}

/** 前端回传内核的原始选择（经 WS agent:answer）。 */
export interface AskReply {
  replies: Array<{
    questionIndex: number;
    selected: string[];       // 选中的 option label；多选可多个；Other 时通常为空
    customText?: string;      // 「其他」自由文本；非空 → kind:"custom"
    notes?: string;           // per-question 备注
  }>;
}

/** 校验错误码（镜像原包 details.error）。 */
export type AskErrorCode =
  | "no_questions" | "too_many_questions" | "empty_options" | "too_many_options"
  | "duplicate_question" | "duplicate_option_label" | "reserved_label";

/** 保留标签：禁止作为 option label（与原包一致）。 */
export const ASK_RESERVED_LABELS = new Set(["Other", "Type something.", "Chat about this", "Next →"]);

/** 校验工具入参。合法返回 null，否则返回首个命中错误码。 */
export function validateAskParams(params: unknown): AskErrorCode | null {
  if (!params || typeof params !== "object") return "no_questions";
  const { questions } = params as { questions?: unknown };
  if (!Array.isArray(questions) || questions.length < 1) return "no_questions";
  if (questions.length > 4) return "too_many_questions";

  const seenQuestions = new Set<string>();
  for (const q of questions as any[]) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) return "no_questions";
    if (seenQuestions.has(q.question)) return "duplicate_question";
    seenQuestions.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 2) return "empty_options";
    if (q.options.length > 4) return "too_many_options";
    const seenOptions = new Set<string>();
    for (const o of q.options as any[]) {
      if (!o || typeof o.label !== "string" || !o.label.trim()) return "empty_options";
      if (ASK_RESERVED_LABELS.has(o.label)) return "reserved_label";
      if (seenOptions.has(o.label)) return "duplicate_option_label";
      seenOptions.add(o.label);
    }
  }
  return null;
}

/** 把前端 AskReply 翻译成 details.answers。 */
export function replyToAnswers(params: AskParams, reply: AskReply): AskAnswer[] {
  return reply.replies.map((r) => {
    const q = params.questions[r.questionIndex];
    const isCustom = typeof r.customText === "string" && r.customText.trim().length > 0;
    const isMulti = q?.multiSelect === true;
    const kind: AskAnswer["kind"] = isCustom ? "custom" : isMulti ? "multi" : "option";
    const notes = typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : undefined;
    return {
      questionIndex: r.questionIndex,
      question: q?.question ?? "",
      kind,
      answer: isCustom ? r.customText!.trim() : (r.selected[0] ?? null),
      selected: isMulti ? r.selected : undefined,
      notes,
    } satisfies AskAnswer;
  });
}
