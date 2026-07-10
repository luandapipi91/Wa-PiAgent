import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

test("只有 toolCall 的 assistant 消息不渲染空白文字气泡", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  // toolCall 面板存在
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  // 不应有文字 block 容器
  expect(screen.queryByTestId("text-block")).toBeNull();
});

test("空字符串 text block 不渲染空白文字气泡", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        assistantMsg(1, [
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "   " },
        ]),
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
  expect(screen.queryByTestId("text-block")).toBeNull();
});

test("空 session 无消息", () => {
  render(<MessageList sessionId="empty" />);
  expect(screen.getByTestId("message-list").children).toHaveLength(0);
});

test("AI 消息名称旁显示发送时间（今天）", () => {
  const ts = new Date();
  ts.setHours(10, 31, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(ts.getTime(), [{ type: "text", text: "你好" }], "dev")],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText(/^dev · 10:31$/)).toBeTruthy();
});

test("用户消息旁显示名称和发送时间（今天）", () => {
  const ts = new Date();
  ts.setHours(14, 22, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hello", timestamp: ts.getTime() } },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText(/^我 · 14:22$/)).toBeTruthy();
});

test("昨天的消息显示「昨天」前缀", () => {
  const ts = new Date();
  ts.setDate(ts.getDate() - 1);
  ts.setHours(9, 5, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(ts.getTime(), [{ type: "text", text: "昨天的消息" }], "dev")],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText(/^dev · 昨天 09:05$/)).toBeTruthy();
});

test("更早的消息显示月日和时间", () => {
  const ts = new Date();
  ts.setMonth(ts.getMonth() - 2);
  ts.setDate(3);
  ts.setHours(8, 7, 0, 0);
  useSessionStore.setState({
    messagesBySession: {
      s1: [assistantMsg(ts.getTime(), [{ type: "text", text: "更早的消息" }], "dev")],
    },
  });
  render(<MessageList sessionId="s1" />);
  const month = String(ts.getMonth() + 1).padStart(2, "0");
  const day = String(ts.getDate()).padStart(2, "0");
  expect(screen.getByText(new RegExp(`^dev · ${month}-${day} 08:07$`))).toBeTruthy();
});

// ── 自动滚动测试 ──

function setScrollMetrics(el: HTMLElement, { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

test("新消息自动滚动到底部", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } }],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });

  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
      ],
    },
  });

  await waitFor(() => {
    expect(list.scrollTop).toBe(1000);
  }, { timeout: 1000 });
});

test("用户手动向上滚动后暂停自动滚动", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } }],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });

  // 用户向上滚动（远离底部）
  list.scrollTop = 500;
  fireEvent.scroll(list);

  // 追加新消息
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
      ],
    },
  });

  // 等待一帧，确认没有自动滚回底部
  await new Promise(r => setTimeout(r, 50));
  expect(list.scrollTop).toBe(500);
});

test("用户手动回到底部后恢复自动滚动", async () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [{ agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } }],
    },
  });
  render(<MessageList sessionId="s1" />);
  const list = screen.getByTestId("message-list");
  setScrollMetrics(list, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });

  // 向上滚动暂停
  list.scrollTop = 500;
  fireEvent.scroll(list);

  // 用户回到底部
  list.scrollTop = 700; // scrollHeight - clientHeight = 700，视为底部
  fireEvent.scroll(list);

  // 追加新消息
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { agentName: undefined, message: { role: "user", content: "hi", timestamp: 1 } },
        assistantMsg(2, [{ type: "text", text: "reply" }]),
        assistantMsg(3, [{ type: "text", text: "more" }]),
      ],
    },
  });

  await waitFor(() => {
    expect(list.scrollTop).toBe(1000);
  }, { timeout: 1000 });
});
