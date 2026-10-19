import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { TurnSummary, formatElapsed } from "../src/components/blocks/TurnSummary";

test("formatElapsed：秒/分钟自动切换", () => {
  expect(formatElapsed(0)).toBe("0 秒");
  expect(formatElapsed(45_000)).toBe("45 秒");
  expect(formatElapsed(135_000)).toBe("2 分 15 秒");
});

test("formatElapsed：小时档（长任务不得再显示几千分钟）", () => {
  expect(formatElapsed(3_661_000)).toBe("1 小时 1 分 1 秒");
  expect(formatElapsed(5 * 3_600_000)).toBe("5 小时 0 分 0 秒");
  // 用户报的「几千分钟」：2524700ms ≈ 42 分 4 秒（<1h 仍走分钟档）
  expect(formatElapsed(2_524_700)).toBe("42 分 4 秒");
});

test("formatElapsed：天档（跨天长任务）", () => {
  expect(formatElapsed(90_061_000)).toBe("1 天 1 小时 1 分 1 秒");
  expect(
    formatElapsed(2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 5_000),
  ).toBe("2 天 3 小时 4 分 5 秒");
});

test("TurnSummary：有时长显示本轮时长 + 步骤数", () => {
  render(<TurnSummary steps={3} elapsedMs={135_000}>过程</TurnSummary>);
  expect(screen.getByText("本轮时长 2 分 15 秒 · 3 个步骤")).toBeTruthy();
});

test("TurnSummary：小时档（长任务显示 x 小时 x 分 x 秒）", () => {
  render(
    <TurnSummary steps={106} elapsedMs={3 * 3_600_000 + 20 * 60_000 + 5_000}>
      过程
    </TurnSummary>,
  );
  expect(screen.getByText("本轮时长 3 小时 20 分 5 秒 · 106 个步骤")).toBeTruthy();
});

test("TurnSummary：天档（跨天长任务显示 x 天 x 小时 x 分 x 秒）", () => {
  render(
    <TurnSummary steps={106} elapsedMs={86_400_000 + 3_600_000 + 60_000 + 5_000}>
      过程
    </TurnSummary>,
  );
  expect(
    screen.getByText("本轮时长 1 天 1 小时 1 分 5 秒 · 106 个步骤"),
  ).toBeTruthy();
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
