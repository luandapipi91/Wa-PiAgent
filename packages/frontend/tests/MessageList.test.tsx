import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";

beforeEach(() => useSessionStore.setState({ messagesBySession: {} }));

test("渲染指定 session 的消息", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { id: "m1", sessionId: "s1", role: "user", text: "你好", timestamp: 0 },
        { id: "m2", sessionId: "s1", role: "assistant", text: "收到", timestamp: 0 },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.getByText("收到")).toBeTruthy();
});

test("空 session 无消息", () => {
  render(<MessageList sessionId="empty" />);
  expect(screen.getByTestId("message-list").children).toHaveLength(0);
});
