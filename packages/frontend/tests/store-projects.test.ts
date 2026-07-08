import { test, expect, beforeEach } from "bun:test";
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

test("addSession 同 id 重复添加不产生重复", () => {
  const sess = { id: "s1", projectId: "p1", primaryAgent: "dev" as const, title: "t", createdAt: 0, lastActivity: 0 };
  useProjectsStore.getState().addSession(sess);
  useProjectsStore.getState().addSession(sess);  // 重复添加同一 session
  expect(useProjectsStore.getState().sessions).toHaveLength(1);  // 应去重
});
