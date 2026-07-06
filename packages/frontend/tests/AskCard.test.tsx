import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskCard } from "../src/components/AskCard";
import type { AskItem } from "@hiagent/shared";

vi.mock("../src/ws-instance", () => ({ send: vi.fn() }));

const ask: AskItem = {
  messageId: "a1", sessionId: "s1", from: "product", to: "dev",
  text: "WebSocket 怎么选", startedAt: Date.now() - 23000, resolved: false,
};

test("未解决显示阻塞计时", () => {
  render(<AskCard ask={ask} />);
  expect(screen.getByText(/阻塞中/)).toBeTruthy();
});

test("点击我来回答展开输入", () => {
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  expect(screen.getByTestId("ask-input")).toBeTruthy();
});

test("提交调 inject-reply", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "用 SSE" } });
  fireEvent.click(screen.getByText("提交"));
  expect(send).toHaveBeenCalledWith({
    type: "intercom:inject-reply", sessionId: "s1", askMessageId: "a1", text: "用 SSE",
  });
});
