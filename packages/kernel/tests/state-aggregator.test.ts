import { test, expect } from "bun:test";
import { StateAggregator } from "../src/state-aggregator";

test("tool_execution_start intercom + expectsReply → intercom:ask", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));
  agg.handleAgentEvent("alice", {
    type: "tool_execution_start", toolCallId: "tc1", toolName: "intercom",
    args: { to: "bob", message: "1+1?", expectsReply: true },
  });
  expect(events[0].type).toBe("intercom:ask");
  expect(events[0]).toMatchObject({ from: "alice", to: "bob", text: "1+1?" });
});

test("intercom reply → intercom:reply", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));
  agg.handleIntercomReply({ toAskMessageId: "msg1", text: "2", from: "bob" });
  expect(events[0]).toMatchObject({ type: "intercom:reply", toAskMessageId: "msg1", text: "2" });
});

test("message_end → agent:message", () => {
  const events: any[] = [];
  const agg = new StateAggregator({} as any, {} as any);
  agg.on("ws:event", e => events.push(e));
  agg.handleAgentEvent("alice", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  expect(events.find(e => e.type === "agent:message").message.text).toBe("hello");
});
