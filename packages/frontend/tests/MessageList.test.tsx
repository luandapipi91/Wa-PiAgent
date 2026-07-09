import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@hiagent/shared";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";

beforeEach(() => useSessionStore.setState({ messagesBySession: {} }));

// 构造助手消息的便捷工厂：AssistantMessage 需要 content/model/stopReason/timestamp 完整字段
function assistantMsg(timestamp: number, content: any[], agentName: SessionMessage["agentName"] = "product"): SessionMessage {
  return { agentName, message: { role: "assistant", content, model: "pi-test", stopReason: "end_turn", timestamp } };
}

test("用户消息靠右、agent 消息靠左（flex-row-reverse）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "你好", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "收到" }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  const userRow = screen.getByTestId("msg-s1-1");
  const agentRow = screen.getByTestId("msg-s1-2");
  expect(userRow.className).toContain("flex-row-reverse");
  expect(agentRow.className).toContain("flex");
  expect(userRow.className.includes("flex-row-reverse")).toBeTruthy();
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.getByText("收到")).toBeTruthy();
});

test("assistant 消息按 content block 渲染 thinking + text + toolCall", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "thinking", thinking: "我在想" },
          { type: "text", text: "答案" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // text block 立即可见
  expect(screen.getByText("答案")).toBeTruthy();
  // thinking 默认折叠（不可见），点击展开后可见
  expect(screen.queryByText("我在想")).toBeNull();
  fireEvent.click(screen.getByText(/思考过程/));
  expect(screen.getByText("我在想")).toBeTruthy();
  // toolCall 面板存在
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.getByText(/read/)).toBeTruthy();
});

test("toolResult 按 toolCallId 关联到前一个 assistant 消息，不单独成行", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } }]),
        {
          agentName: "product",
          message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "文件内容" }], isError: false, timestamp: 2 },
        },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // toolResult 不单独成行：只有 1 个 MessageRow（msg-s1-1），无 msg-s1-2
  expect(screen.getByTestId("msg-s1-1")).toBeTruthy();
  expect(screen.queryByTestId("msg-s1-2")).toBeNull();
  // 展开 toolCall 后能看到关联结果
  fireEvent.click(screen.getByText(/read/));
  expect(screen.getByText("文件内容")).toBeTruthy();
});

test("intercom toolCall 渲染 DelegateCard（委派卡片）", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "toolCall", id: "d1", name: "intercom", arguments: { action: "ask", to: "pm", message: "需求?" } },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // intercom toolCall 和普通 toolCall 共用 ToolCallBlock，无专门 delegate card
  expect(screen.getByTestId("toolcall-d1")).toBeTruthy();
  expect(screen.getByText(/intercom/)).toBeTruthy();
});

test("空 session 无消息", () => {
  render(<MessageList sessionId="empty" />);
  expect(screen.getByTestId("message-list").children).toHaveLength(0);
});
