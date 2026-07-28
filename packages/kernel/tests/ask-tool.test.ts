import { test, expect, beforeEach } from "bun:test";
import { makeAskTool, reconcileDanglingAsks } from "../src/ask-tool";
import { askRegistry } from "../src/ask-registry";
import type { AskParams } from "@hiagent/shared";

const validParams: AskParams = { questions: [
  { question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
] };

beforeEach(() => askRegistry.reset());

test("makeAskTool: 工具名为 ask_user_question", () => {
  const t = makeAskTool("s1") as any;
  expect(t.name).toBe("ask_user_question");
});

test("execute: 非法 params（无 questions）→ details.error，不注册、不阻塞", async () => {
  const t = makeAskTool("s1") as any;
  const out = await t.execute("tc1", { questions: [] }, new AbortController().signal);
  expect(out.details.error).toBe("no_questions");
  expect(out.details.cancelled).toBe(false);
});

test("execute: 合法 params → 阻塞，resolve 后返回 answers", async () => {
  const t = makeAskTool("s1") as any;
  const p = t.execute("tc1", validParams, new AbortController().signal);
  askRegistry.resolve("s1", "tc1", { replies: [{ questionIndex: 0, selected: ["A"] }] });
  const out = await p;
  expect(out.details.cancelled).toBe(false);
  expect(out.details.answers[0]).toMatchObject({ kind: "option", answer: "A" });
  expect(out.content[0].type).toBe("text");
});

test("execute: cancel → details.cancelled=true", async () => {
  const t = makeAskTool("s1") as any;
  const p = t.execute("tc1", validParams, new AbortController().signal);
  askRegistry.cancel("s1", "tc1");
  const out = await p;
  expect(out.details.cancelled).toBe(true);
});

test("reconcileDanglingAsks: 对无 toolResult 的 ask 工具调用注入 cancelled 结果", () => {
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "ask_user_question", arguments: validParams }], model: "m", stopReason: "tool_use", timestamp: 1 },
  ];
  const out = reconcileDanglingAsks(messages);
  expect(out).toHaveLength(2);
  const injected = out[1] as Record<string, unknown>;
  expect(injected.role).toBe("toolResult");
  expect(injected.toolCallId).toBe("tc1");
  expect(injected.toolName).toBe("ask_user_question");
  expect(injected.isError).toBe(false);
});

test("reconcileDanglingAsks: 已有 toolResult 的 ask 不重复注入", () => {
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "ask_user_question", arguments: validParams }], model: "m", stopReason: "tool_use", timestamp: 1 },
    { role: "toolResult", toolCallId: "tc1", toolName: "ask_user_question", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 },
  ];
  expect(reconcileDanglingAsks(messages)).toHaveLength(2);  // 原样返回
});

test("reconcileDanglingAsks: session 活跃时不注入 cancelled（agent 仍在等待回答）", () => {
  // 场景：agent 正在运行且有一个 pending ask，用户切到别的会话再切回来。
  // 消息中有问无答，但 agent 进程仍在等待——不应误判为「重启后残留」。
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "ask_user_question", arguments: validParams }], model: "m", stopReason: "tool_use", timestamp: 1 },
  ];
  const out = reconcileDanglingAsks(messages, { isSessionActive: true });
  expect(out).toHaveLength(1);  // 不注入 cancelled toolResult
});

test("reconcileDanglingAsks: session 不活跃时正常注入 cancelled（重启兜底）", () => {
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "ask_user_question", arguments: validParams }], model: "m", stopReason: "tool_use", timestamp: 1 },
  ];
  const out = reconcileDanglingAsks(messages, { isSessionActive: false });
  expect(out).toHaveLength(2);  // 注入 cancelled toolResult
  expect((out[1] as any).role).toBe("toolResult");
});
