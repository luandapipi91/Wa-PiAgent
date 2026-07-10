import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectList } from "../src/components/ProjectList";
import { useProjectsStore } from "../src/store/projects";
import { useProjectUiStore } from "../src/store/project-ui";

beforeEach(() => {
  useProjectsStore.setState({
    projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
  });
  useProjectUiStore.setState({ collapsedProjectIds: [] });
});

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

test("在新会话界面但点击未选中的项目时，切换到该项目新会话，不折叠", () => {
  useProjectsStore.setState({
    projects: [
      { id: "p1", name: "项目A", cwd: "/a", createdAt: 0 },
      { id: "p2", name: "项目B", cwd: "/b", createdAt: 0 },
    ],
    sessions: [
      { id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now(), piSessionFile: "" },
      { id: "s2", projectId: "p2", primaryAgent: "dev", title: "会话2", createdAt: 0, lastActivity: Date.now(), piSessionFile: "" },
    ],
    currentProjectId: "p1",
    currentSessionId: null,
  });
  const onSelectProject = mock();
  render(
    <ProjectList
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={onSelectProject}
      onNewProject={() => {}}
      currentView="new-session"
    />
  );
  fireEvent.click(screen.getByText("项目B"));
  expect(onSelectProject).toHaveBeenCalledWith("p2");
  // 项目 B 原本就是展开的，点击后不应改变折叠状态
  expect(screen.getByText("会话2")).toBeTruthy();
});

test("不在新会话界面时，点击项目名进入该项目新会话，不折叠项目", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now(), piSessionFile: "" }],
    currentProjectId: "p1",
    currentSessionId: "s1",
  });
  const onSelectProject = mock();
  render(
    <ProjectList
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={onSelectProject}
      onNewProject={() => {}}
      currentView="session"
    />
  );
  expect(screen.getByText("会话1")).toBeTruthy();
  fireEvent.click(screen.getByText("项目A"));
  expect(onSelectProject).toHaveBeenCalledWith("p1");
  expect(screen.getByText("会话1")).toBeTruthy();
});

test("在新会话界面且已选中该项目时，点击项目名展开/折叠", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话1", createdAt: 0, lastActivity: Date.now(), piSessionFile: "" }],
    currentProjectId: "p1",
    currentSessionId: null,
  });
  const onSelectProject = mock();
  render(
    <ProjectList
      onSelectSession={() => {}}
      onNewSessionInProject={() => {}}
      onSelectProject={onSelectProject}
      onNewProject={() => {}}
      currentView="new-session"
    />
  );
  fireEvent.click(screen.getByText("项目A"));
  expect(onSelectProject).not.toHaveBeenCalled();
  expect(screen.queryByText("会话1")).toBeNull();
  fireEvent.click(screen.getByText("项目A"));
  expect(screen.getByText("会话1")).toBeTruthy();
});
