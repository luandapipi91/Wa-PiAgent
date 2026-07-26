import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import { useProjectUiStore } from "../src/store/project-ui";
import type { SessionEntity } from "@hiagent/shared";

// 捕获 REST API 调用，替代已删除的 ws-instance send mock
const apiCalls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { apiCalls.push({ method: "get", path }); return Promise.resolve({}); },
    post: (path: string, body?: any) => { apiCalls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: (path: string, body?: any) => { apiCalls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: (path: string) => { apiCalls.push({ method: "del", path }); return Promise.resolve({}); },
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

const project = { id: "p1", name: "项目A", cwd: "/a", createdAt: 0 };

// 三个会话，lastActivity 故意乱序，验证排序后倒序显示
const sessions: SessionEntity[] = [
  { id: "old",   projectId: "p1", primaryAgent: "dev",  title: "旧会话", createdAt: 0, lastActivity: 1000, piSessionFile: "" },
  { id: "new",   projectId: "p1", primaryAgent: "pm",   title: "新会话", createdAt: 0, lastActivity: 3000, piSessionFile: "" },
  { id: "mid",   projectId: "p1", primaryAgent: "test", title: "中会话", createdAt: 0, lastActivity: 2000, piSessionFile: "" },
];

beforeEach(async () => {
  apiCalls.length = 0;
  useProjectUiStore.setState({ collapsedProjectIds: [] });
  await act(async () => {
    await useProjectUiStore.persist.rehydrate();
  });
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

test("confirm 点确认 → 调用 DELETE /api/sessions/:id 并关闭", () => {
  renderIt();
  fireEvent.contextMenu(screen.getByTestId("session-old"));
  fireEvent.click(screen.getByTestId("menu-delete"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  expect(apiCalls).toContainEqual({ method: "del", path: "/api/sessions/old" });
  expect(screen.queryByTestId("confirm-dialog")).toBeNull();
});

test("confirm 点取消 → 不发送请求并关闭", () => {
  renderIt();
  fireEvent.contextMenu(screen.getByTestId("session-old"));
  fireEvent.click(screen.getByTestId("menu-delete"));
  fireEvent.click(screen.getByTestId("confirm-cancel"));
  expect(apiCalls).toHaveLength(0);
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

test("项目折叠状态会持久化：折叠后重新挂载仍保持折叠", () => {
  renderIt();
  expect(screen.getByTestId("session-new")).toBeTruthy();

  fireEvent.click(screen.getByTestId("project-toggle-p1"));
  cleanup();

  // 重新挂载组件，模拟刷新页面后恢复持久化状态
  renderIt();
  expect(screen.queryByTestId("session-new")).toBeNull();

  fireEvent.click(screen.getByTestId("project-toggle-p1"));
  expect(screen.getByTestId("session-new")).toBeTruthy();
});
