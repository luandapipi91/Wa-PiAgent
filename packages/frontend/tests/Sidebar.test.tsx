import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Sidebar } from "../src/components/Sidebar";
import { useProjectsStore } from "../src/store/projects";

// 渲染后清理 DOM：happy-dom 全局 document 跨测试文件共享，不清理会污染后续文件
afterEach(() => cleanup());

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [], currentProjectId: null, currentSessionId: null });
});

test("渲染四区容器 + 新建会话按钮", () => {
  render(<Sidebar onNewSession={() => {}} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  expect(screen.getByTestId("sidebar")).toBeTruthy();
  expect(screen.getByText(/新建会话/)).toBeTruthy();
  // 分组标题改为大写"智能体"
  expect(screen.getByText("智能体")).toBeTruthy();
  // "项目"区头现在仅在存在用户项目时渲染（ProjectList 的 userProjects.length>0 条件）；
  // 此处 projects 为空，故不断言该区头。改成有项目时再验证区头出现：
  expect(screen.queryByText(/^项目$/)).toBeNull();
});

test("透传 onNewSession", () => {
  const fn = mock();
  render(<Sidebar onNewSession={fn} onChatWith={() => {}} onEdit={() => {}} onMore={() => {}} onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-session-btn"));
  expect(fn).toHaveBeenCalledTimes(1);
});

// 默认工作区渲染位置 + 去重测试已迁移到 ProjectList.test.tsx
// （默认工作区现在由 ProjectList 渲染，而非 Sidebar 直接渲染）
