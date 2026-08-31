import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionRow } from "../src/components/SessionRow";
import { useSessionStore } from "../src/store/session";
import type { SessionEntity } from "@wa-pi/shared";

const session: SessionEntity = {
  id: "s1", projectId: "p1", primaryAgent: "技术实现",
  title: "测试会话", createdAt: 0, lastActivity: Date.now() - 120000, piSessionFile: "",
};

// 渲染后清理 DOM：happy-dom 全局 document 跨测试共享，不清理会互相污染
afterEach(() => cleanup());

beforeEach(() => { useSessionStore.setState({ unreadBySession: {}, statusBySession: {}, messagesBySession: {} }); });

test("显示 emoji + 标题 + 相对时间", () => {
  render(<table><tbody><SessionRow session={session} selected={false} onSelect={() => {}} /></tbody></table>);
  // 旧默认角色（技术实现）已下线，avatar 查不到时回退默认 🤖
  expect(screen.getByText("🤖")).toBeTruthy();
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

// ── pending ask：等待用户回答时显示问号，替代误导的 spinner ──

test("有 pending ask（thinking）→ 显示问号，不显示 spinner", () => {
  // 1) 置 statusBySession = thinking
  useSessionStore.setState((s) => ({
    statusBySession: { ...s.statusBySession, s1: "thinking" },
  }));
  // 2) 注入一条含 ask_user_question（无 toolResult）的 assistant 消息
  useSessionStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      s1: [
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc1",
                name: "ask_user_question",
                arguments: {
                  questions: [
                    {
                      question: "Q?",
                      header: "h",
                      options: [{ label: "A", description: "x" }],
                    },
                  ],
                },
              },
            ],
            model: "m",
            stopReason: "tool_use",
            timestamp: 1,
          },
          agentName: "dev",
        },
      ],
    },
  }));
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  expect(screen.getByTestId("session-awaiting-s1")).toBeTruthy();
  expect(screen.queryByTestId("session-running-s1")).toBeNull();
  // a11y：等待回答语义 + 问号替代时间位
  expect(screen.getByLabelText("等待回答")).toBeTruthy();
  expect(screen.queryByText("2m")).toBeNull();
});

test("thinking 且无 pending ask → 仍显示 spinner", () => {
  useSessionStore.setState((s) => ({
    statusBySession: { ...s.statusBySession, s1: "thinking" },
    messagesBySession: { ...s.messagesBySession, s1: [] },
  }));
  render(<SessionRow session={session} selected={false} onSelect={() => {}} />);
  expect(screen.getByTestId("session-running-s1")).toBeTruthy();
  expect(screen.queryByTestId("session-awaiting-s1")).toBeNull();
});

test("subtitle 存在时渲染在标题下方", () => {
  render(
    <table><tbody>
      <SessionRow session={session} selected={false} onSelect={() => {}} subtitle="HiAgent" />
    </tbody></table>,
  );
  expect(screen.getByText("HiAgent")).toBeTruthy();
  expect(screen.getByTestId("session-subtitle-s1")).toBeTruthy();
});

test("subtitle 缺省时不渲染 meta 行", () => {
  const { container } = render(<table><tbody><SessionRow session={session} selected={false} onSelect={() => {}} /></tbody></table>);
  expect(container.querySelector("[data-testid='session-subtitle-s1']")).toBeNull();
});
