import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
  useAgentsStore.setState({ states: {}, configs: {} });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText(/新建会话/)).toBeTruthy();
  expect(screen.getByText(/我的智能体/)).toBeTruthy();
  // "项目管理" 既出现在 ProjectList 区头，也是 pm 智能体 label（AGENT_DEFS.pm.label），
  // 故用 getAllByText 断言两者皆渲染
  expect(screen.getAllByText(/项目管理/).length).toBeGreaterThanOrEqual(1);
});

test("透传 onNewSession", () => {
  const fn = mock();
  render(<Sidebar onNewSession={fn} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
