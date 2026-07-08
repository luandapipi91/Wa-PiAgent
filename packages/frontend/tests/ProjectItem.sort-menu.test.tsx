import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import type { SessionEntity } from "@hiagent/shared";

// mock ws-instance：捕获 send 调用，断言删除/重命名事件被正确发送。
// bun 的 mock.module 不像 vitest vi.mock 自动 hoist，但 factory 闭包可引用本模块作用域
// 的 sendMock（mock.module 在 import 解析时注册 mock，实际 factory 在首次 import
// ws-instance 时执行，此时 sendMock 已初始化）。
const sendMock = mock();
mock.module("../src/ws-instance", () => ({ send: sendMock }));

const project = { id: "p1", name: "项目A", cwd: "/a", createdAt: 0 };

// 三个会话，lastActivity 故意乱序，验证排序后倒序显示
const sessions: SessionEntity[] = [
  { id: "old",   projectId: "p1", primaryAgent: "dev",  title: "旧会话", createdAt: 0, lastActivity: 1000, piSessionFile: "" },
  { id: "new",   projectId: "p1", primaryAgent: "pm",   title: "新会话", createdAt: 0, lastActivity: 3000, piSessionFile: "" },
  { id: "mid",   projectId: "p1", primaryAgent: "test", title: "中会话", createdAt: 0, lastActivity: 2000, piSessionFile: "" },
];

beforeEach(() => {
  sendMock.mockClear();
});

// 每个测试后清理 DOM，避免残留元素干扰后续测试
afterEach(() => {
  cleanup();
});

function renderIt() {
  render(
    <ProjectItem
      project={project}
      sessions={sessions}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
}

test("会话按 lastActivity 倒序显示（最新在顶）", () => {
  renderIt();
  const rows = screen.getAllByText(/会话$/).map(el => el.textContent);
  expect(rows).toEqual(["新会话", "中会话", "旧会话"]);
});

test("右键会话弹出 popup 菜单", () => {
  renderIt();
  // 菜单初始不存在
  expect(screen.queryByTestId("session-context-menu")).toBeNull();
  // 右键某个会话
  fireEvent.contextMenu(screen.getByTestId("session-new"));
  expect(screen.getByTestId("session-context-menu")).toBeTruthy();
  expect(screen.getByTestId("menu-rename")).toBeTruthy();
  expect(screen.getByTestId("menu-delete")).toBeTruthy();
});

test("点击「删除聊天」弹出 confirm 确认框", () => {
  renderIt();
  fireEvent.contextMenu(screen.getByTestId("session-new"));
  fireEvent.click(screen.getByTestId("menu-delete"));
  // popup 关闭、confirm 打开
  expect(screen.queryByTestId("session-context-menu")).toBeNull();
  expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
  // 确认框描述里包含会话标题
  expect(screen.getByTestId("confirm-dialog").textContent).toContain("新会话");
});

test("confirm 点确认 → 发送 session:delete 事件并关闭", () => {
  renderIt();
  fireEvent.contextMenu(screen.getByTestId("session-old"));
  fireEvent.click(screen.getByTestId("menu-delete"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  expect(sendMock).toHaveBeenCalledWith({ type: "session:delete", sessionId: "old" });
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
});

test("confirm 点取消 → 不发送事件并关闭", () => {
  renderIt();
  fireEvent.contextMenu(screen.getByTestId("session-old"));
  fireEvent.click(screen.getByTestId("menu-delete"));
  fireEvent.click(screen.getByTestId("confirm-cancel"));
  expect(sendMock).not.toHaveBeenCalled();
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
});

test("点击空白处关闭 popup 菜单", async () => {
  renderIt();
  fireEvent.contextMenu(screen.getByTestId("session-new"));
  expect(screen.getByTestId("session-context-menu")).toBeTruthy();
  // 等 setTimeout(fn, 0) 将 click 监听器绑定到 document
  await new Promise(r => setTimeout(r, 10));
  // 在 document 上触发 click（冒泡到 document 监听器，兼容 happy-dom）
  fireEvent.click(window.document);
  await waitFor(() => {
    expect(screen.queryByTestId("session-context-menu")).toBeNull();
  });
});
