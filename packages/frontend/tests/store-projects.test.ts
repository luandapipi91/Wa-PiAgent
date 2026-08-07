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

test("addSession 只 append 不自动选中（避免 IM 会话被动创建时抢占视图）", () => {
  useProjectsStore.getState().addSession({
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "",
  });
  expect(useProjectsStore.getState().sessions).toHaveLength(1);
  // 不自动设 currentSessionId——选中是 selectSession 的职责
  expect(useProjectsStore.getState().currentSessionId).toBeNull();
});

test("IM 会话（session:created 广播）append 时不抢占当前视图", () => {
  // 用户正在 s1 会话工作
  useProjectsStore.getState().addSession({
    id: "s1", projectId: "p1", primaryAgent: "dev",
    title: "我的工作会话", createdAt: 0, lastActivity: 0, piSessionFile: "",
  });
  useProjectsStore.getState().selectSession("s1");
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");

  // IM 消息进来，后端广播 session:created → addSession（IM 会话）
  useProjectsStore.getState().addSession({
    id: "im-ch_xxx-__system__-1700000000000",
    projectId: "__system__", primaryAgent: "前端开发者",
    title: "IM · woq4", createdAt: 0, lastActivity: 0, piSessionFile: "",
  });
  // IM 会话进列表了
  expect(useProjectsStore.getState().sessions).toHaveLength(2);
  // 但当前视图仍是用户的工作会话，没被打断
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");
});

test("addSession 同 id 重复添加不产生重复", () => {
  const sess = { id: "s1", projectId: "p1", primaryAgent: "dev" as const, title: "t", createdAt: 0, lastActivity: 0, piSessionFile: "" };
  useProjectsStore.getState().addSession(sess);
  useProjectsStore.getState().addSession(sess);  // 重复添加同一 session
  expect(useProjectsStore.getState().sessions).toHaveLength(1);  // 应去重
});

test("selectSession 更新该会话 lastActivity（排序/时间显示依据），其他会话不受影响", () => {
  const before = Date.now() - 10_000;
  useProjectsStore.getState().addSession({ id: "s1", projectId: "p1", primaryAgent: "dev" as const, title: "t", createdAt: 0, lastActivity: before, piSessionFile: "" });
  useProjectsStore.getState().addSession({ id: "s2", projectId: "p1", primaryAgent: "dev" as const, title: "t2", createdAt: 0, lastActivity: 0, piSessionFile: "" });

  useProjectsStore.getState().selectSession("s1");

  const s1 = useProjectsStore.getState().sessions.find(x => x.id === "s1")!;
  const s2 = useProjectsStore.getState().sessions.find(x => x.id === "s2")!;
  // 必须被刷新为当前时间（明显大于激活前的 before），否则排序/时间显示不会更新
  expect(s1.lastActivity).toBeGreaterThan(before + 5000);
  expect(s1.lastActivity).toBeLessThanOrEqual(Date.now() + 1000);
  expect(s2.lastActivity).toBe(0);  // 未激活的会话不变
});
