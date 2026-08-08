import { test, expect } from "bun:test";
import { selectPendingAsks } from "../src/store/ask";
import type { SessionMessage } from "@wa-pi/shared";

function assistantMsg(toolCalls: any[], timestamp = 1): SessionMessage {
  return { message: { role: "assistant", content: toolCalls, model: "m", stopReason: "tool_use", timestamp } as any, agentName: "dev" };
}
function toolResultMsg(toolCallId: string, timestamp = 2): SessionMessage {
  return { message: { role: "toolResult", toolCallId, toolName: "ask_user_question", content: [{ type: "text", text: "ok" }], isError: false, timestamp } as any, agentName: "dev" };
}

const askCall = { type: "toolCall", id: "tc1", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } };

test("selectPendingAsks: 找出无 result 的 ask 调用", () => {
  const msgs = [assistantMsg([askCall])];
  const pending = selectPendingAsks(msgs);
  expect(pending).toHaveLength(1);
  expect(pending[0].toolCallId).toBe("tc1");
  expect(pending[0].params.questions).toHaveLength(1);
});

test("selectPendingAsks: 有 result 的 ask 不算 pending", () => {
  const msgs = [assistantMsg([askCall]), toolResultMsg("tc1")];
  expect(selectPendingAsks(msgs)).toHaveLength(0);
});

test("selectPendingAsks: 多个 pending；忽略非 ask 的 toolCall", () => {
  const msgs = [assistantMsg([
    askCall,
    { type: "toolCall", id: "tc2", name: "read", arguments: {} },
    { type: "toolCall", id: "tc3", name: "ask_user_question", arguments: { questions: [{ question: "Q2?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } },
  ])];
  const pending = selectPendingAsks(msgs);
  expect(pending.map(p => p.toolCallId).sort()).toEqual(["tc1", "tc3"]);
});
