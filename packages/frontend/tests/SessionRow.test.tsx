import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import { useSessionStore } from "../src/store/session";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: Date.now() - 120000, piSessionFile: "",
};

beforeEach(() => { useSessionStore.setState({ unreadBySession: {} }); });

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

// ── 未读 new 角标（后台收到回复完成时显示，45° 斜标）──

test("未读会话显示 45° new 角标", () => {
  useSessionStore.setState({ unreadBySession: { s1: true } });
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  const tag = screen.getByTestId("unread-tag-s1");
  expect(tag.textContent).toBe("new");
  expect(tag.className).toContain("rotate-45"); // 45° 斜着
});

test("已读会话不显示 new 角标", () => {
  useSessionStore.setState({ unreadBySession: {} });
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  expect(screen.queryByTestId("unread-tag-s1")).toBeNull();
});
