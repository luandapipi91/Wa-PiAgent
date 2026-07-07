import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskCard } from "../src/components/AskCard";
import type { AskItem } from "@hiagent/shared";

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

test("提交后收起输入区回到按钮", () => {
  // 不 mock send（polyfill 兜底）；断言行为：填回复→提交→input 消失，answer 按钮重现
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "用 SSE" } });
  fireEvent.click(screen.getByText("提交"));
  // submit 后 setAnswering(false) → input 区隐藏，回到「🙋 我来回答」
  expect(screen.queryByTestId("ask-input")).toBeNull();
  expect(screen.getByTestId("ask-answer-btn")).toBeTruthy();
});
