import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import type { SessionEntity } from "@hiagent/shared";

// mock ws-instance：捕获 send 调用，断言删除/重命名事件被正确发送
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("../src/ws-instance", () => ({ send: sendMock }));

const project = { id: "p1", name: "项目A", cwd: "/a", createdAt: 0 };

// 三个会话，lastActivity 故意乱序，验证排序后倒序显示
const sessions: SessionEntity[] = [
  { id: "old",   projectId: "p1", primaryAgent: "dev",  title: "旧会话", createdAt: 0, lastActivity: 1000 },
  { id: "new",   projectId: "p1", primaryAgent: "pm",   title: "新会话", createdAt: 0, lastActivity: 3000 },
  { id: "mid",   projectId: "p1", primaryAgent: "test", title: "中会话", createdAt: 0, lastActivity: 2000 },
];

beforeEach(() => {
  sendMock.mockClear();
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
  // 触发 window click（requestAnimationFrame 后绑定的监听）
  await new Promise(r => setTimeout(r, 20));  // 等一帧让 raf 执行
  fireEvent.click(window.document.body);
  await waitFor(() => {
    expect(screen.queryByTestId("session-context-menu")).toBeNull();
  });
});
