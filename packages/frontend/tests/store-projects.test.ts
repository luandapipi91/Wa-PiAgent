import { test, expect, beforeEach } from "vitest";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("setAll 设置项目列表", () => {
  useProjectsStore.getState().setAll(
    [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    [],
  );
  expect(useProjectsStore.getState().projects).toHaveLength(1);
});

test("addSession 切到新会话", () => {
  useProjectsStore.getState().addSession({
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "t", createdAt: 0, lastActivity: 0,
  });
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");
});
