import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SYSTEM_PROJECT_ID } from "@hiagent/shared";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText(/新建会话/)).toBeTruthy();
  // 分组标题改为大写"智能体"
  expect(screen.getByText("智能体")).toBeTruthy();
  // "项目"既出现在 ProjectList 区头，也是 pm 智能体 label（AGENT_DEFS.pm.label="项目管理"包含"项目"）
  expect(screen.getAllByText(/^项目$/).length).toBeGreaterThanOrEqual(1);
});

test("透传 onNewSession", () => {
  const fn = mock();
  render(<Sidebar onNewSession={fn} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledTimes(1);
});

test("默认工作区渲染在独立区（无小标题）", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
      { id: "p1", name: "HiAgent", cwd: "/work/hiagent", createdAt: 0 },
    ],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  // 默认工作区项目直接渲染（无"默认"小标题）
  expect(screen.getByText("默认工作区")).toBeTruthy();
  expect(screen.queryByText("默认")).toBeNull();
  // "项目" 区标题仍存在
  expect(screen.getAllByText(/^项目$/).length).toBeGreaterThanOrEqual(1);
});

test("默认工作区不出现在项目区（去重）", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp/workdir", createdAt: 0 },
      { id: "p1", name: "HiAgent", cwd: "/work/hiagent", createdAt: 0 },
    ],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  // 只有一处渲染"默认工作区"
  expect(screen.getAllByText("默认工作区").length).toBe(1);
});
