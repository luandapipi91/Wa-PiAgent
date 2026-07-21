import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import { useProjectUiStore } from "../src/store/project-ui";
import { SYSTEM_PROJECT_ID, type SessionEntity } from "@hiagent/shared";

// mock ws-instance：捕获 send 调用，必要时断言事件被正确发送。
// bun 的 mock.module 在 import 解析时注册 mock，factory 闭包可引用本模块作用域的 sendMock。
const sendMock = mock();
mock.module("../src/ws-instance", () => ({ send: sendMock }));

const systemProject = { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 };
const normalProject = { id: "p1", name: "HiAgent", cwd: "/work", createdAt: 0 };

beforeEach(() => {
  sendMock.mockClear();
  // 默认 expanded（空 collapsedProjectIds 表示全部展开）
  useProjectUiStore.setState({ collapsedProjectIds: [] });
});

// 每个测试后清理 DOM，避免残留元素（特别是 createPortal 到 body 的右键菜单）干扰后续测试
afterEach(() => {
  cleanup();
});

test("系统项目折叠时图标用 🏠", () => {
  // 显式把系统项目置为折叠状态
  useProjectUiStore.setState({ collapsedProjectIds: [SYSTEM_PROJECT_ID] });
  render(
    <ProjectItem
      project={systemProject}
      sessions={[]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  expect(screen.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`).textContent).toContain("🏠");
});

test("系统项目右键菜单不显示'删除项目'", () => {
  render(
    <ProjectItem
      project={systemProject}
      sessions={[]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  // 右键项目名（header 内的 button，handler 挂在 header div 上，事件会冒泡触发）
  fireEvent.contextMenu(screen.getByTestId(`project-name-${SYSTEM_PROJECT_ID}`));
  expect(screen.queryByTestId("menu-delete-project")).toBeNull();
  // "查看文件夹" 仍然显示
  expect(screen.getByTestId("menu-open-dir")).toBeTruthy();
});

test("系统项目下会话右键菜单有'打开工作目录'项", () => {
  const session: SessionEntity = {
    id: "s1",
    projectId: SYSTEM_PROJECT_ID,
    primaryAgent: "dev",
    title: "会话",
    createdAt: 1721000000000,
    lastActivity: Date.now(),
    piSessionFile: "",
  };
  render(
    <ProjectItem
      project={systemProject}
      sessions={[session]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  fireEvent.contextMenu(screen.getByText("会话"));
  expect(screen.getByTestId("menu-open-session-dir")).toBeTruthy();
  // 点击"打开工作目录"应触发 project:open-dir 事件，携带 projectId+sessionId
  fireEvent.click(screen.getByTestId("menu-open-session-dir"));
  expect(sendMock).toHaveBeenCalledTimes(1);
  expect(sendMock).toHaveBeenCalledWith({
    type: "project:open-dir",
    projectId: SYSTEM_PROJECT_ID,
    sessionId: "s1",
  });
});

test("普通项目折叠时图标用 📁（行为不变）", () => {
  useProjectUiStore.setState({ collapsedProjectIds: ["p1"] });
  render(
    <ProjectItem
      project={normalProject}
      sessions={[]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  expect(screen.getByTestId("project-toggle-p1").textContent).toContain("📁");
});

test("普通项目右键菜单有'删除项目'（行为不变）", () => {
  render(
    <ProjectItem
      project={normalProject}
      sessions={[]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  // 右键项目名（header 内的 button，handler 挂在 header div 上，事件会冒泡触发）
  fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
  expect(screen.getByTestId("menu-delete-project")).toBeTruthy();
});

test("普通项目下会话右键菜单无'打开工作目录'（行为不变）", () => {
  const session: SessionEntity = {
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev",
    title: "会话",
    createdAt: 0,
    lastActivity: Date.now(),
    piSessionFile: "",
  };
  render(
    <ProjectItem
      project={normalProject}
      sessions={[session]}
      currentSessionId={null}
      selected={false}
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={() => {}}
    />
  );
  fireEvent.contextMenu(screen.getByText("会话"));
  expect(screen.queryByTestId("menu-open-session-dir")).toBeNull();
});
