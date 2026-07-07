import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectList } from "../src/components/ProjectList";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("渲染项目 + 会话", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now() }],
    currentProjectId: null, currentSessionId: null,
  });
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={() => {}} />);
  expect(screen.getByText("项目A")).toBeTruthy();
  expect(screen.getByText("会话1")).toBeTruthy();
});

test("项目内 ＋ 触发 onNewSessionInProject", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/a", createdAt: 0 }],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  const fn = mock();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={fn} onProjectSettings={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-in-p1"));
  expect(fn).toHaveBeenCalledWith("p1");
});

test("新建项目按钮", () => {
  const fn = mock();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onProjectSettings={() => {}} onNewProject={fn} />);
  fireEvent.click(screen.getByTestId("new-project-btn"));
  expect(fn).toHaveBeenCalledOnce();
});
