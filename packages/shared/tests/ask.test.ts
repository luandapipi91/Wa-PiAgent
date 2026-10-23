import { test, expect } from "bun:test";
import {
  validateAskParams, replyToAnswers, ASK_RESERVED_LABELS,
  type AskParams, type AskReply,
} from "../src/ask";

const okParams: AskParams = {
  questions: [
    { question: "用哪个方案?", header: "方案", options: [
      { label: "A", description: "甲" }, { label: "B", description: "乙" } ] },
  ],
};

test("validateAskParams: 合法参数返回 null", () => {
  expect(validateAskParams(okParams)).toBeNull();
});

test("validateAskParams: questions 缺失 → no_questions", () => {
  expect(validateAskParams({})).toBe("no_questions");
  expect(validateAskParams({ questions: [] })).toBe("no_questions");
});

test("validateAskParams: questions > 4 → too_many_questions", () => {
  const qs = Array.from({ length: 5 }, (_, i) => ({
    question: `Q${i}?`, header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }],
  }));
  expect(validateAskParams({ questions: qs })).toBe("too_many_questions");
});

test("validateAskParams: options < 2 → empty_options；> 4 → too_many_options", () => {
  expect(validateAskParams({ questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }] }] })).toBe("empty_options");
  const opts = Array.from({ length: 5 }, (_, i) => ({ label: `O${i}`, description: "x" }));
  expect(validateAskParams({ questions: [{ question: "Q?", header: "h", options: opts }] })).toBe("too_many_options");
});

test("validateAskParams: 重复问题文本 → duplicate_question", () => {
  const p: AskParams = { questions: [
    { question: "Same?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
    { question: "Same?", header: "h", options: [{ label: "C", description: "x" }, { label: "D", description: "y" }] },
  ] };
  expect(validateAskParams(p)).toBe("duplicate_question");
});

test("validateAskParams: 同问内重复 option label → duplicate_option_label", () => {
  const p: AskParams = { questions: [{ question: "Q?", header: "h", options: [
    { label: "A", description: "x" }, { label: "A", description: "y" }] }] };
  expect(validateAskParams(p)).toBe("duplicate_option_label");
});

test("validateAskParams: 保留 label（Other / sentinels）→ reserved_label", () => {
  for (const bad of ASK_RESERVED_LABELS) {
    const p = { questions: [{ question: "Q?", header: "h", options: [
      { label: bad, description: "x" }, { label: "ok", description: "y" }] }] };
    expect(validateAskParams(p)).toBe("reserved_label");
  }
});

test("replyToAnswers: 单选 → option；多选 → multi；含 customText → custom", () => {
  const params: AskParams = { questions: [
    { question: "单?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
    { question: "多?", header: "h", multiSelect: true, options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
    { question: "自?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
  ] };
  const reply: AskReply = { replies: [
    { questionIndex: 0, selected: ["A"] },
    { questionIndex: 1, selected: ["A", "B"] },
    { questionIndex: 2, selected: [], customText: "随便说" },
  ] };
  const answers = replyToAnswers(params, reply);
  expect(answers).toHaveLength(3);
  expect(answers[0]).toMatchObject({ questionIndex: 0, kind: "option", answer: "A" });
  expect(answers[1]).toMatchObject({ questionIndex: 1, kind: "multi", selected: ["A", "B"] });
  expect(answers[2]).toMatchObject({ questionIndex: 2, kind: "custom", answer: "随便说" });
});

test("replyToAnswers: notes 透传（空白去掉）", () => {
  const params: AskParams = { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] };
  const answers = replyToAnswers(params, { replies: [{ questionIndex: 0, selected: ["A"], notes: "  备注  " }] });
  expect(answers[0].notes).toBe("备注");
});
