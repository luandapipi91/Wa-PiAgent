import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import { useSessionStore } from "../src/store/session";
import type { SessionEntity } from "@hiagent/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "dev",
  title: "测试会话", createdAt: 0, lastActivity: Date.now() - 120000, piSessionFile: "",
};

beforeEach(() => { useSessionStore.setState({ unreadBySession: {}, statusBySession: {} }); });

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

// ── 未读圆点角标（后台收到回复完成时显示，右上角小圆点）──

test("未读会话显示右上角小圆点（无文字）", () => {
  useSessionStore.setState({ unreadBySession: { s1: true } });
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  const tag = screen.getByTestId("unread-tag-s1");
  // 小圆点：无文字内容
  expect(tag.textContent).toBe("");
  // 应该是圆形的（borderRadius: 50% 或足够大）
  expect(tag.style.borderRadius).toBe("50%");
  // 应该很小
  expect(tag.style.width).toBe("7px");
  expect(tag.style.height).toBe("7px");
});

test("已读会话不显示圆点角标", () => {
  useSessionStore.setState({ unreadBySession: {} });
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  expect(screen.queryByTestId("unread-tag-s1")).toBeNull();
});

// ── 运行中：右侧时间位替换为 loading，结束后恢复时间 ──

test("会话运行中（thinking）显示 loading、隐藏时间", () => {
  useSessionStore.setState({ statusBySession: { s1: "thinking" } });
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  expect(screen.getByTestId("session-running-s1")).toBeTruthy();
  expect(screen.queryByText("2m")).toBeNull();
});

test("会话空闲显示时间、无 loading", () => {
  useSessionStore.setState({ statusBySession: {} });
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  expect(screen.getByText("2m")).toBeTruthy();
  expect(screen.queryByTestId("session-running-s1")).toBeNull();
});
