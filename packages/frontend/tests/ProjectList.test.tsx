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
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now(), piSessionFile: "" }],
    currentProjectId: null, currentSessionId: null,
  });
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={() => {}} />);
  expect(screen.getByText("项目A")).toBeTruthy();
  expect(screen.getByText("会话1")).toBeTruthy();
});

// 该用例对应的"项目名旁 + 号"按钮已在 9c97fd8 移除（点击项目名即可新建会话），
// testid `new-in-p1` 不复存在，故跳过。保留用例以备将来恢复该交互时参考。
test.skip("项目内 ＋ 触发 onNewSessionInProject", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/a", createdAt: 0 }],
    sessions: [], currentProjectId: null, currentSessionId: null,
  });
  const fn = mock();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={fn} onSelectProject={() => {}} onNewProject={() => {}} />);
  fireEvent.click(screen.getByTestId("new-in-p1"));
  expect(fn).toHaveBeenCalledWith("p1");
});

test("新建项目按钮", () => {
  const fn = mock();
  render(<ProjectList onSelectSession={() => {}} onNewSessionInProject={() => {}} onSelectProject={() => {}} onNewProject={fn} />);
  fireEvent.click(screen.getByTestId("new-project-btn"));
  expect(fn).toHaveBeenCalledTimes(1);
});
