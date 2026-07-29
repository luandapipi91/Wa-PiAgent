import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ProjectItem } from "../src/components/ProjectItem";
import { useProjectUiStore } from "../src/store/project-ui";
import { SYSTEM_PROJECT_ID, type SessionEntity } from "@wa-pi/shared";

// mock api-client：捕获 REST 调用，必要时断言请求被正确发出。
// bun 的 mock.module 在 import 解析时注册 mock，factory 闭包可引用本模块作用域的 calls。
const calls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve({}); },
    post: (path: string, body?: any) => { calls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: (path: string, body?: any) => { calls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: (path: string) => { calls.push({ method: "del", path }); return Promise.resolve({}); },
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

const systemProject = { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 };
const normalProject = { id: "p1", name: "WaPi", cwd: "/work", createdAt: 0 };

beforeEach(() => {
  calls.length = 0;
  // 默认 expanded（空 collapsedProjectIds 表示全部展开）
  useProjectUiStore.setState({ collapsedProjectIds: [] });
});

// 每个测试后清理 DOM，避免残留元素（特别是 createPortal 到 body 的右键菜单）干扰后续测试
afterEach(() => {
  cleanup();
});

test("系统项目始终显示 🏠（不论展开/折叠）", () => {
  // 折叠状态
  useProjectUiStore.setState({ collapsedProjectIds: [SYSTEM_PROJECT_ID] });
  const { rerender } = render(
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

  // 展开状态（清空 collapsedProjectIds）
  act(() => {
    useProjectUiStore.setState({ collapsedProjectIds: [] });
  });
  rerender(
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
  // 展开后图标仍是 🏠（不能变成 📂，否则失去默认工作区辨识度）
  expect(screen.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`).textContent).toContain("🏠");
  expect(screen.getByTestId(`project-toggle-${SYSTEM_PROJECT_ID}`).textContent).not.toContain("📂");
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
  act(() => {
    fireEvent.contextMenu(screen.getByTestId(`project-name-${SYSTEM_PROJECT_ID}`));
  });
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
  act(() => {
    fireEvent.contextMenu(screen.getByText("会话"));
  });
  expect(screen.getByTestId("menu-open-session-dir")).toBeTruthy();
  // 点击"打开工作目录"应调用 POST /api/projects/{projectId}/open-dir，携带 sessionId
  act(() => {
    fireEvent.click(screen.getByTestId("menu-open-session-dir"));
  });
  const openDirCalls = calls.filter((c) => c.method === "post" && c.path === `/api/projects/${encodeURIComponent(SYSTEM_PROJECT_ID)}/open-dir`);
  expect(openDirCalls).toHaveLength(1);
  expect(openDirCalls[0].body).toEqual({ sessionId: "s1" });
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
  act(() => {
    fireEvent.contextMenu(screen.getByTestId("project-name-p1"));
  });
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
  act(() => {
    fireEvent.contextMenu(screen.getByText("会话"));
  });
  expect(screen.queryByTestId("menu-open-session-dir")).toBeNull();
});
