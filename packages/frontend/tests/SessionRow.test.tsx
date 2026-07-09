import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: Date.now() - 120000, piSessionFile: "",
};

test("显示 emoji + 标题 + 相对时间", () => {
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={() => {}} /></tbody></table>);
  expect(screen.getByText("⚙️")).toBeTruthy();
  expect(screen.getByText("测试会话")).toBeTruthy();
  expect(screen.getByText("2m")).toBeTruthy();
});

test("选中态蓝左条", () => {
  const { container } = render(<table><tbody><SessionRow session={session} selected={true} onSelect={() => {}} /></tbody></table>);
  const btn = container.querySelector("[data-testid='session-s1']") as HTMLElement;
  // 选中态左条用 accent CSS 变量（浅色主题下值由 styles.css 提供）
  expect(btn.style.borderLeft).toContain("var(--accent)");
});

test("点击 onSelect", () => {
  const fn = mock();
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={fn} /></tbody></table>);
  fireEvent.click(screen.getByTestId("session-s1"));
  expect(fn).toHaveBeenCalledWith("s1");
});
