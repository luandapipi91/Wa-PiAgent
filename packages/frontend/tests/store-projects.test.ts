import { test, expect, beforeEach, mock } from "bun:test";
import { useProjectsStore } from "../src/store/projects";

const postMock = mock();
const getMock = mock();
mock.module("../src/api-client", () => ({
  api: {
    get: getMock,
    post: postMock,
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

beforeEach(() => {
  useProjectsStore.setState({
    projects: [],
    sessions: [],
    currentProjectId: null,
    currentSessionId: null,
    dirPickerOpen: false,
  });
  postMock.mockReset();
  postMock.mockImplementation(async () => ({}));
  getMock.mockReset();
  getMock.mockImplementation(() => Promise.resolve({}));
  delete (window as any).waPiApp;
});

test("setAll 设置项目列表", () => {
  useProjectsStore
    .getState()
    .setAll([{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }], []);
  expect(useProjectsStore.getState().projects).toHaveLength(1);
});

test("addSession 只 append 不自动选中（避免 IM 会话被动创建时抢占视图）", () => {
  useProjectsStore.getState().addSession({
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev",
    title: "t",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  });
  expect(useProjectsStore.getState().sessions).toHaveLength(1);
  // 不自动设 currentSessionId——选中是 selectSession 的职责
  expect(useProjectsStore.getState().currentSessionId).toBeNull();
});

test("IM 会话（session:created 广播）append 时不抢占当前视图", () => {
  // 用户正在 s1 会话工作
  useProjectsStore.getState().addSession({
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev",
    title: "我的工作会话",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  });
  useProjectsStore.getState().selectSession("s1");
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");

  // IM 消息进来，后端广播 session:created → addSession（IM 会话）
  useProjectsStore.getState().addSession({
    id: "im-ch_xxx-__system__-1700000000000",
    projectId: "__system__",
    primaryAgent: "前端开发者",
    title: "IM · woq4",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  });
  // IM 会话进列表了
  expect(useProjectsStore.getState().sessions).toHaveLength(2);
  // 但当前视图仍是用户的工作会话，没被打断
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");
});

test("addSession 同 id 重复添加不产生重复", () => {
  const sess = {
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev" as const,
    title: "t",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  };
  useProjectsStore.getState().addSession(sess);
  useProjectsStore.getState().addSession(sess); // 重复添加同一 session
  expect(useProjectsStore.getState().sessions).toHaveLength(1); // 应去重
});

test("selectSession 仅选中会话，不更新 lastActivity（只有发消息/收回复才算激活）", () => {
  const before = Date.now() - 10_000;
  useProjectsStore.getState().addSession({
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev" as const,
    title: "t",
    createdAt: 0,
    lastActivity: before,
    piSessionFile: "",
  });
  useProjectsStore.getState().addSession({
    id: "s2",
    projectId: "p1",
    primaryAgent: "dev" as const,
    title: "t2",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  });

  useProjectsStore.getState().selectSession("s1");

  const s1 = useProjectsStore.getState().sessions.find((x) => x.id === "s1")!;
  const s2 = useProjectsStore.getState().sessions.find((x) => x.id === "s2")!;
  // 点击查看不再视为活跃：lastActivity 保持原值不变（不再被刷新为当前时间）
  expect(s1.lastActivity).toBe(before);
  expect(s2.lastActivity).toBe(0);
  // 选中逻辑仍生效：currentSessionId 更新
  expect(useProjectsStore.getState().currentSessionId).toBe("s1");
});

test("touchSession 更新指定会话 lastActivity（发消息/收回复时调用），其他会话不受影响", () => {
  const before = Date.now() - 10_000;
  useProjectsStore.getState().addSession({
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev" as const,
    title: "t",
    createdAt: 0,
    lastActivity: before,
    piSessionFile: "",
  });
  useProjectsStore.getState().addSession({
    id: "s2",
    projectId: "p1",
    primaryAgent: "dev" as const,
    title: "t2",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  });

  useProjectsStore.getState().touchSession("s1");

  const s1 = useProjectsStore.getState().sessions.find((x) => x.id === "s1")!;
  const s2 = useProjectsStore.getState().sessions.find((x) => x.id === "s2")!;
  // 发消息/收回复视为活跃：对应会话 lastActivity 刷新为当前时间
  expect(s1.lastActivity).toBeGreaterThan(before + 5000);
  expect(s1.lastActivity).toBeLessThanOrEqual(Date.now() + 1000);
  expect(s2.lastActivity).toBe(0); // 未活跃的会话不变
});

test("touchSession 不存在的会话 id 不报错且不改变任何会话", () => {
  useProjectsStore.getState().addSession({
    id: "s1",
    projectId: "p1",
    primaryAgent: "dev" as const,
    title: "t",
    createdAt: 0,
    lastActivity: 100,
    piSessionFile: "",
  });
  useProjectsStore.getState().touchSession("missing");
  expect(useProjectsStore.getState().sessions[0].lastActivity).toBe(100);
});

test("Electron 下 createProjectFromDir 用系统目录对话框选目录并创建项目", async () => {
  (window as any).waPiApp = {
    showOpenDirectoryDialog: async () => "/Users/co/myproj",
  };
  await useProjectsStore.getState().createProjectFromDir();
  expect(postMock).toHaveBeenCalledWith("/api/projects", {
    name: "myproj",
    cwd: "/Users/co/myproj",
  });
  expect(useProjectsStore.getState().dirPickerOpen).toBe(false);
});

test("非 Electron 环境 createProjectFromDir 回退打开内置目录树", async () => {
  await useProjectsStore.getState().createProjectFromDir();
  expect(useProjectsStore.getState().dirPickerOpen).toBe(true);
  expect(postMock).not.toHaveBeenCalled();
});

test("系统目录对话框取消时（null）不创建项目也不开内置树", async () => {
  (window as any).waPiApp = {
    showOpenDirectoryDialog: async () => null,
  };
  await useProjectsStore.getState().createProjectFromDir();
  expect(useProjectsStore.getState().dirPickerOpen).toBe(false);
  expect(postMock).not.toHaveBeenCalled();
});

test("setAll 快照滞后时不挤掉乐观新建的当前会话（新会话首次发送不空白/不重置）", () => {
  // 模拟新会话首次发送：乐观 addSession + selectSession
  useProjectsStore.getState().addSession({
    id: "s-new",
    projectId: "p1",
    primaryAgent: "dev",
    title: "t",
    createdAt: 0,
    lastActivity: Date.now(),
    piSessionFile: "",
  });
  useProjectsStore.getState().selectSession("s-new");
  expect(useProjectsStore.getState().currentSessionId).toBe("s-new");

  // kernel 广播 projects:list，快照滞后：不含乐观新建的 s-new（placeholder 未转正）
  useProjectsStore.getState().setAll(
    [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    [
      {
        id: "s-old",
        projectId: "p1",
        primaryAgent: "dev",
        title: "old",
        createdAt: 0,
        lastActivity: 0,
        piSessionFile: "",
      },
    ],
  );

  // 期望：正在查看的当前会话仍留在 sessions 数组，SessionView 不因 find 不到而 return null
  const sessions = useProjectsStore.getState().sessions;
  expect(sessions.some((x) => x.id === "s-new")).toBe(true);
  // currentSessionId 也不应被清
  expect(useProjectsStore.getState().currentSessionId).toBe("s-new");
});

test("setAll 不复活已被删除的会话（删除后 currentSessionId 已置 null 的会话不保留）", () => {
  // 模拟被删除的会话：它曾存在，但删除时 setCurrentSessionId(null)，且不在 kernel 快照里
  useProjectsStore.getState().addSession({
    id: "s-deleted",
    projectId: "p1",
    primaryAgent: "dev",
    title: "deleted",
    createdAt: 0,
    lastActivity: 0,
    piSessionFile: "",
  });
  // 删除 handler 会清 currentSessionId（模拟删除当前会话）
  useProjectsStore.getState().setCurrentSessionId(null);

  // kernel 快照：s-deleted 已不在（被删除），只剩一个正常会话
  useProjectsStore.getState().setAll(
    [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    [
      {
        id: "s-old",
        projectId: "p1",
        primaryAgent: "dev",
        title: "old",
        createdAt: 0,
        lastActivity: 0,
        piSessionFile: "",
      },
    ],
  );

  // 期望：被删除的会话不复活，sessions 只含 kernel 快照里的 s-old
  const sessions = useProjectsStore.getState().sessions;
  expect(sessions.some((x) => x.id === "s-deleted")).toBe(false);
});

test("load() 快照滞后时不挤掉乐观新建的当前会话（SSE 重连/启动时同源保护）", async () => {
  // 模拟新会话首次发送：乐观 addSession + selectSession
  useProjectsStore.getState().addSession({
    id: "s-new",
    projectId: "p1",
    primaryAgent: "dev",
    title: "t",
    createdAt: 0,
    lastActivity: Date.now(),
    piSessionFile: "",
  });
  useProjectsStore.getState().selectSession("s-new");
  expect(useProjectsStore.getState().currentSessionId).toBe("s-new");

  // load() 拉取 /api/projects，快照滞后：不含乐观新建的 s-new（placeholder 未转正）
  getMock.mockImplementation(() =>
    Promise.resolve({
      projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
      sessions: [
        {
          id: "s-old",
          projectId: "p1",
          primaryAgent: "dev",
          title: "old",
          createdAt: 0,
          lastActivity: 0,
          piSessionFile: "",
        },
      ],
    }),
  );

  await useProjectsStore.getState().load();

  // 期望：正在查看的当前会话仍留在 sessions 数组，不因 load() 整表赋值而丢失
  const sessions = useProjectsStore.getState().sessions;
  expect(sessions.some((x) => x.id === "s-new")).toBe(true);
  expect(useProjectsStore.getState().currentSessionId).toBe("s-new");
});
