// Task 8: store/session.ts — sdk:event 处理与流式两态管理的单测
// 说明：项目测试栈为 bun:test（非 vitest），按项目既有规范编写。
import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import type { SDKEventEnvelope } from "@hiagent/shared";

beforeEach(() => {
  // 每个 case 前重置状态，避免相互污染
  useSessionStore.setState({
    messagesBySession: {},
    streamingBySession: {},
    statusBySession: {},
    optimisticEchoBySession: {},
    historyLoadingBySession: {},
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

// ── 历史加载标记：SessionView 发请求置 true、收响应置 false ──

test("setHistoryLoading：按会话隔离地切换加载标志", () => {
  useSessionStore.getState().setHistoryLoading("s1", true);
  useSessionStore.getState().setHistoryLoading("s2", true);
  expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(true);
  expect(useSessionStore.getState().historyLoadingBySession["s2"]).toBe(true);
  // 仅清 s1，不影响 s2
  useSessionStore.getState().setHistoryLoading("s1", false);
  expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(false);
  expect(useSessionStore.getState().historyLoadingBySession["s2"]).toBe(true);
});

// ── 未读标记：非当前会话收到回复完成（agent_end）标记 new，进入会话清掉 ──

test("agent_end：非当前会话标记未读；当前会话不标记", () => {
  useProjectsStore.setState({ currentSessionId: "s-cur" });
  // 非当前会话 s1 完成 → 未读
  useSessionStore.getState().handleSDKEvent("s1", envelope({ type: "agent_end", messages: [], willRetry: false }));
  expect(useSessionStore.getState().unreadBySession["s1"]).toBe(true);
  // 当前会话 s-cur 完成 → 不标记
  useSessionStore.getState().handleSDKEvent("s-cur", envelope({ type: "agent_end", messages: [], willRetry: false }));
  expect(useSessionStore.getState().unreadBySession["s-cur"]).toBeFalsy();
});

test("markUnread / markRead 维护 unreadBySession", () => {
  useSessionStore.getState().markUnread("s1");
  expect(useSessionStore.getState().unreadBySession["s1"]).toBe(true);
  useSessionStore.getState().markRead("s1");
  expect(useSessionStore.getState().unreadBySession["s1"]).toBeFalsy();
});

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

test("message_end 失败且 content 为空 → 不新增 assistant 行、仅清空 streaming", () => {
  // 先模拟 streaming 占位 + 一条 user 消息
  useSessionStore.setState({
    streamingBySession: {
      s1: { message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 2 }, agentName: "dev" },
    },
    messagesBySession: { s1: [{ agentName: "dev", message: { role: "user", content: "hi", timestamp: 1 } }] },
  });
  const env = envelope({
    type: "message_end",
    message: { role: "assistant", content: [], model: "m", stopReason: "error", timestamp: 2 },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  // streaming 清空
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
  // 不新增 assistant 行（仍只有 1 条 user 消息）—— 避免渲染裸头像行
  expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(1);
});

test("message_end 失败但有部分内容 → 照常合并（保留部分回复，红色渲染）", () => {
  useSessionStore.setState({
    streamingBySession: {
      s1: { message: { role: "assistant", content: [], model: "m", stopReason: "stop", timestamp: 2 }, agentName: "dev" },
    },
    messagesBySession: { s1: [{ agentName: "dev", message: { role: "user", content: "hi", timestamp: 1 } }] },
  });
  const env = envelope({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "部分回复" }], model: "m", stopReason: "error", timestamp: 2 },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  expect(useSessionStore.getState().streamingBySession["s1"]).toBeNull();
  // 合并出一条 assistant 行（共 2 条）
  expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(2);
});

test("truncate(sessionId, fromIndex) 保留 [0, fromIndex)，丢弃其后所有行（重发原地重试用）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "失败的那条", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "⚠️ 失败" }], model: "system", stopReason: "error", timestamp: 2 } },
      ],
    },
  });
  useSessionStore.getState().truncate("s1", 0);  // 从失败用户行(index 0)起裁
  expect(useSessionStore.getState().messagesBySession["s1"]).toHaveLength(0);
});

test("truncate 仅裁掉指定索引及之后，保留前序消息", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "早", timestamp: 1 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "好" }], model: "m", stopReason: "stop", timestamp: 2 } },
        { agentName: undefined, message: { role: "user", content: "失败的那条", timestamp: 3 } },
        { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "⚠️" }], model: "system", stopReason: "error", timestamp: 4 } },
      ],
    },
  });
  useSessionStore.getState().truncate("s1", 2);  // 裁掉 index 2（失败用户行）及之后
  const msgs = useSessionStore.getState().messagesBySession["s1"];
  expect(msgs).toHaveLength(2);
  expect((msgs[1].message as any).content[0].text).toBe("好");
});

// ── 乐观发送（optimistic UI）──

test("optimisticSend 立即追加用户消息 + 占位 assistant streaming + status=thinking", () => {
  useSessionStore.getState().optimisticSend("s1", "你好", "dev");
  const s = useSessionStore.getState();
  expect(s.messagesBySession["s1"]).toHaveLength(1);
  expect((s.messagesBySession["s1"][0].message as any).role).toBe("user");
  expect((s.messagesBySession["s1"][0].message as any).content).toBe("你好");
  // 占位流式 assistant（让 MessageList 渲染 loading 气泡）
  expect(s.streamingBySession["s1"]).toBeTruthy();
  expect((s.streamingBySession["s1"]!.message as any).role).toBe("assistant");
  // 顶部 spinner 立即可见
  expect(s.statusBySession["s1"]).toBe("thinking");
  // 标记：等待 SDK message_start(user) 回声替换占位
  expect(s.optimisticEchoBySession["s1"]).toBe(true);
});

test("message_start(user) 回声 → 替换乐观占位（不重复行），用 SDK 权威 timestamp，清标记", () => {
  useSessionStore.getState().optimisticSend("s1", "你好", "dev");
  const env = envelope({
    type: "message_start",
    message: { role: "user", content: "你好", timestamp: 999 },
  });
  useSessionStore.getState().handleSDKEvent("s1", env);
  const s = useSessionStore.getState();
  expect(s.messagesBySession["s1"]).toHaveLength(1);  // 不重复
  expect((s.messagesBySession["s1"][0].message as any).timestamp).toBe(999);  // SDK 权威 ts
  expect(s.optimisticEchoBySession["s1"]).toBe(false);
});

test("message_start(user) 无乐观占位 → 照常追加（不误替换历史用户消息）", () => {
  // 先有一条 assistant 历史，再收到 user message_start（非乐观路径）
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "历史" }], model: "m", stopReason: "stop", timestamp: 1 } }],
    },
  });
  const env = envelope({ type: "message_start", message: { role: "user", content: "新问题", timestamp: 2 } });
  useSessionStore.getState().handleSDKEvent("s1", env);
  const msgs = useSessionStore.getState().messagesBySession["s1"];
  expect(msgs).toHaveLength(2);  // 追加，不替换
  expect((msgs[1].message as any).content).toBe("新问题");
});
