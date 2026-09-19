import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { TurnSummary, formatElapsed } from "../src/components/blocks/TurnSummary";

test("formatElapsed：秒/分钟自动切换", () => {
  expect(formatElapsed(0)).toBe("0 秒");
  expect(formatElapsed(45_000)).toBe("45 秒");
  expect(formatElapsed(135_000)).toBe("2 分 15 秒");
});

test("TurnSummary：有时长显示本轮时长 + 步骤数", () => {
  render(<TurnSummary steps={3} elapsedMs={135_000}>过程</TurnSummary>);
  expect(screen.getByText("本轮时长 2 分 15 秒 · 3 个步骤")).toBeTruthy();
});

test("TurnSummary：无时长显示本轮过程 + 步骤数", () => {
  render(<TurnSummary steps={2}>过程</TurnSummary>);
  expect(screen.getByText("本轮过程 · 2 个步骤")).toBeTruthy();
});

test("TurnSummary：默认折叠，点击展开 children，再点折叠", () => {
  render(<TurnSummary steps={1}>卡片内容</TurnSummary>);
  expect(screen.queryByText("卡片内容")).toBeNull();
  fireEvent.click(screen.getByTestId("turn-summary"));
  expect(screen.getByText("卡片内容")).toBeTruthy();
  fireEvent.click(screen.getByTestId("turn-summary"));
  expect(screen.queryByText("卡片内容")).toBeNull();
});

test("TurnSummary：aria-expanded 随状态切换", () => {
  render(<TurnSummary steps={1}>过程</TurnSummary>);
  const btn = screen.getByTestId("turn-summary");
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(btn);
  expect(btn.getAttribute("aria-expanded")).toBe("true");
});
