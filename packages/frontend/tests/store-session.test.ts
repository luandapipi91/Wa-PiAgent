// Task 8: store/session.ts — sdk:event 处理与流式两态管理的单测
// 说明：项目测试栈为 bun:test（非 vitest），按项目既有规范编写。
import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { SDKEventEnvelope } from "@hiagent/shared";

beforeEach(() => {
  // 每个 case 前重置三个状态，避免相互污染
  useSessionStore.setState({
    messagesBySession: {},
    streamingBySession: {},
    statusBySession: {},
  });
});

// 构造 sdk:event 信封的便捷工厂
function envelope(event: SDKEventEnvelope["event"], sessionId = "s1"): SDKEventEnvelope {
  return {
    type: "sdk:event",
    projectId: "p1",
    sessionId,
    agentName: "dev",
    event,
  };
}

test("message_start(user) 添加用户消息到 messages", () => {
  const env = envelope({
    type: "message_start",
    message: { role: "user", content: "你好", timestamp: 1 },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
  expect(useSessionStore.getState().messagesBySession["s1"][0].message).toEqual({
    role: "user",
    content: "你好",
    timestamp: 1,
  });
});

test("message_start(assistant) 设置 streamingMessage", () => {
  const env = envelope({
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      model: "m",
      stopReason: "stop",
      timestamp: 2,
    },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeTruthy();
});

test("message_end 把 streamingMessage 移到 messages 并清空 streaming", () => {
  // 先模拟 message_start(assistant) 设好 streaming
  useSessionStore.setState({
    streamingBySession: {
      s1: {
        message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 2 },
        agentName: "dev",
      },
    },
  });
  const env = envelope({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "回复" }],
      model: "m",
      stopReason: "stop",
      timestamp: 2,
    },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
  expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
});

test("message_end(user) 不重复添加——user 消息在 message_start 时已加入", () => {
  // 先模拟 message_start(user) 已加入 messages
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ message: { role: "user", content: "你好", timestamp: 1 }, agentName: "dev" }],
    },
  });
  // message_end(user) 不应再添加
  const env = envelope({
    type: "message_end",
    message: { role: "user", content: "你好", timestamp: 1 },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
});

test("agent_start 设置 status=thinking", () => {
  const env = envelope({ type: "agent_start" });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
});

test("agent_end 设置 status=idle", () => {
  useSessionStore.setState({ statusBySession: { s1: "thinking" } });
  const env = envelope({ type: "agent_end", messages: [], willRetry: false });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().statusBySession["s1"]).toBe("idle");
});

test("message_update 更新 streamingMessage（用 assistantMessageEvent.partial）", () => {
  // 先设初始 streaming
  useSessionStore.setState({
    streamingBySession: {
      s1: {
        message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 2 },
        agentName: "dev",
      },
    },
  });
  const env = envelope({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "部分" }], model: "m", stopReason: "stop", timestamp: 2 },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "部分",
      partial: { role: "assistant", content: [{ type: "text", text: "部分" }], model: "m", stopReason: "stop", timestamp: 2 },
    },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  const streaming = useSessionStore.getState().streamingBySession["s1"];
  expect(streaming).toBeTruthy();
  // partial 应反映流式增量
  expect((streaming!.message as any).content[0].text).toBe("部分");
});

test("handleSDKEvent 不影响其他 session 的状态", () => {
  // s2 已有消息，s1 处理事件不应波及 s2
  useSessionStore.setState({
    messagesBySession: { s2: [{ agentName: "dev", message: { role: "user", content: "hi", timestamp: 1 } }] },
  });
  const env = envelope({ type: "agent_start" });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().messagesBySession["s2"]).toHaveLength(1);
  expect(useSessionStore.getState().statusBySession["s1"]).toBe("thinking");
});
