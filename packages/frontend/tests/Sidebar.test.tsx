import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText(/新建会话/)).toBeTruthy();
  // 分组标题改为大写"智能体"
  expect(screen.getByText("智能体")).toBeTruthy();
  // "项目"既出现在 ProjectList 区头，也是 pm 智能体 label（AGENT_DEFS.pm.label="项目管理"包含"项目"）
  expect(screen.getAllByText(/^项目$/).length).toBeGreaterThanOrEqual(1);
});

test("透传 onNewSession", () => {
  const fn = mock();
  render(<Sidebar onNewSession={fn} onSelectAgent={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledTimes(1);
});
