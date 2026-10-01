import { test, expect, beforeEach, mock } from "bun:test";
import { useMcpStore } from "../src/store/mcp";
import { useToastStore } from "../src/store/toast";

// store 的 load/save/... 会触发 api.get/post/del（真实 fetch），
// happy-dom 在 about:blank 下对相对 URL 抛 NotSupportedError。mock 掉 api-client，
// 用可编程的假实现：既让 .then/.catch 正常走，也能断言「打了哪个端点、带了什么 body」。
type Call = { method: string; path: string; body?: unknown };
const calls: Call[] = [];
let getImpl: (path: string) => Promise<unknown> = () => Promise.resolve(null);
let postImpl: (path: string, body?: unknown) => Promise<unknown> = () =>
  Promise.resolve({});
let delImpl: (path: string) => Promise<unknown> = () => Promise.resolve({});

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      calls.push({ method: "GET", path });
      return getImpl(path);
    },
    post: (path: string, body?: unknown) => {
      calls.push({ method: "POST", path, body });
      return postImpl(path, body);
    },
    put: () => Promise.resolve({}),
    del: (path: string) => {
      calls.push({ method: "DELETE", path });
      return delImpl(path);
    },
  },
}));

beforeEach(() => {
  calls.length = 0;
  getImpl = () => Promise.resolve(null);
  postImpl = () => Promise.resolve({});
  delImpl = () => Promise.resolve({});
  useToastStore.setState({ toasts: [] });
  useMcpStore.setState({
    servers: [],
    stale: false,
    note: undefined,
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    projectScopeEnabled: null,
    serverStatuses: {},
    toolCounts: {},
    toolsCache: {},
    loadingTools: {},
    testingServers: {},
    errors: {},
  });
});

test("load 发起列表请求并置 loading", () => {
  useMcpStore.getState().load();
  expect(useMcpStore.getState().loading).toBe(true);
  expect(calls).toEqual([{ method: "GET", path: "/api/mcp" }]);
});

test("load 带 projectId 时更新 selectedProjectId 并带上查询参数", () => {
  useMcpStore.getState().load("p1");
  expect(useMcpStore.getState().selectedProjectId).toBe("p1");
  expect(calls[0].path).toBe("/api/mcp?projectId=p1");
});

test("setServers 装载清单、stale 与 note 并清除 loading", () => {
  useMcpStore.getState().load();
  useMcpStore.getState().setServers({
    servers: [{ name: "test", command: "echo", state: "connected" }],
    stale: true,
    note: "project not trusted",
  });
  const s = useMcpStore.getState();
  expect(s.servers).toEqual([
    { name: "test", command: "echo", state: "connected" },
  ]);
  expect(s.stale).toBe(true);
  expect(s.note).toBe("project not trusted");
  expect(s.loading).toBe(false);
});

test("setServers 直接消费内核回推的 mcp:changed 事件", () => {
  useMcpStore.setState({ selectedProjectId: "p1" });
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    projectId: "p1",
    servers: [{ name: "changed-svr", url: "http://localhost:3845/mcp" }],
  });
  expect(useMcpStore.getState().servers).toEqual([
    { name: "changed-svr", url: "http://localhost:3845/mcp" },
  ]);
});

// ===== 元信息的来源区分（REST 回包恒带完整元信息；事件可缺字段）=====

test("mcp:changed 事件不带 stale/note 时不清零既有元信息", () => {
  useMcpStore.setState({
    selectedProjectId: "p1",
    stale: true,
    note: "…/.pi/mcp.json is ignored because the project is not trusted.",
  });
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    projectId: "p1",
    servers: [{ name: "dbx", command: "echo" }],
  });
  const s = useMcpStore.getState();
  // 广播丢弃元信息时，前端不得把「状态未知」与「项目未受信」的说明抹掉
  expect(s.stale).toBe(true);
  expect(s.note).toBe(
    "…/.pi/mcp.json is ignored because the project is not trusted.",
  );
});

test("mcp:changed 事件带 stale/note 时照常改写（不能只保旧值）", () => {
  useMcpStore.setState({ selectedProjectId: "p1", stale: false, note: undefined });
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    projectId: "p1",
    servers: [{ name: "dbx", command: "echo" }],
    stale: true,
    note: "项目未受信任",
  });
  const s = useMcpStore.getState();
  expect(s.stale).toBe(true);
  expect(s.note).toBe("项目未受信任");
});

test("REST 清单回包缺 note 时清零：项目受信后横幅必须消失", () => {
  useMcpStore.setState({
    selectedProjectId: "p1",
    stale: true,
    note: "项目未受信任",
  });
  useMcpStore.getState().setServers({ servers: [], stale: false }, "p1");
  const s = useMcpStore.getState();
  expect(s.note).toBeUndefined();
  expect(s.stale).toBe(false);
});

// ===== 作用域过滤（登记在案的既有缺陷：项目级改动会覆盖全局视图）=====

test("非当前作用域的清单被丢弃（项目级广播不覆盖全局视图）", () => {
  useMcpStore.setState({
    selectedProjectId: null,
    servers: [{ name: "global-svr", command: "echo" }],
  });
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    projectId: "p1",
    servers: [{ name: "project-svr", command: "echo" }],
  });
  // 全局视图不变
  expect(useMcpStore.getState().servers).toEqual([
    { name: "global-svr", command: "echo" },
  ]);
});

test("全局清单不覆盖项目视图，当前作用域的清单照常装载", () => {
  useMcpStore.setState({
    selectedProjectId: "p1",
    servers: [{ name: "project-svr", command: "echo" }],
  });
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    projectId: undefined,
    servers: [{ name: "global-svr", command: "echo" }],
  });
  expect(useMcpStore.getState().servers).toEqual([
    { name: "project-svr", command: "echo" },
  ]);

  useMcpStore.getState().setServers(
    { servers: [{ name: "project-svr-2", command: "echo" }] },
    "p1",
  );
  expect(useMcpStore.getState().servers).toEqual([
    { name: "project-svr-2", command: "echo" },
  ]);
});

test("load 的晚到响应不覆盖已切走的作用域", async () => {
  let resolveGet: (v: unknown) => void = () => {};
  getImpl = () =>
    new Promise((resolve) => {
      resolveGet = resolve;
    });
  useMcpStore.getState().load("p1");
  // 响应回来前用户切到全局
  useMcpStore.getState().setSelectedProjectId(null);
  resolveGet({ servers: [{ name: "late", command: "echo" }] });
  await Promise.resolve();
  await Promise.resolve();
  expect(useMcpStore.getState().servers).toEqual([]);
});

// ===== 测试结果 / 工具列表 =====

test("setTestResult 成功更新状态为 connected 并记 toolCount", () => {
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "ok-svr",
    success: true,
    status: "connected",
    toolCount: 5,
  });
  expect(useMcpStore.getState().serverStatuses["ok-svr"]).toBe("connected");
  expect(useMcpStore.getState().toolCounts["ok-svr"]).toBe(5);
});

test("setTestResult 失败（带 code）按字典渲染错误并清 testing 标记", () => {
  useMcpStore.getState().testConnection("dbx");
  expect(useMcpStore.getState().testingServers["dbx"]).toBe(true);
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "dbx",
    success: false,
    status: "error",
    code: "mcp.serverNotFound",
    params: { name: "dbx" },
    error: "MCP server dbx not found",
  });
  expect(useMcpStore.getState().testingServers["dbx"]).toBeUndefined();
  expect(useMcpStore.getState().serverStatuses["dbx"]).toBe("error");
  // 字典渲染后的中文文案，不露出 code 原文
  expect(useMcpStore.getState().errors["dbx"]).toContain("dbx");
  expect(useMcpStore.getState().errors["dbx"]).not.toContain("mcp.serverNotFound");
});

test("testConnection 清掉上一次错误", () => {
  useMcpStore.setState({ errors: { dbx: "上次失败" } });
  useMcpStore.getState().testConnection("dbx", "p1");
  expect(useMcpStore.getState().testingServers["dbx"]).toBe(true);
  expect(useMcpStore.getState().errors["dbx"]).toBeUndefined();
  expect(calls[0]).toEqual({
    method: "POST",
    path: "/api/mcp/test",
    body: { serverName: "dbx", projectId: "p1" },
  });
});

test("setToolsResult 清 loading 并缓存工具", () => {
  useMcpStore.getState().listTools("dbx", "p1");
  expect(useMcpStore.getState().loadingTools["dbx"]).toBe(true);
  useMcpStore.getState().setToolsResult({
    type: "mcp:tools",
    serverName: "dbx",
    tools: [{ name: "tool_a" }],
  });
  expect(useMcpStore.getState().loadingTools["dbx"]).toBe(false);
  expect(useMcpStore.getState().toolsCache["dbx"]).toEqual([{ name: "tool_a" }]);
  expect(calls[0].path).toBe("/api/mcp/dbx/tools?projectId=p1");
});

test("装载清单不再逐台自动测试（状态直接来自列表回包，避免 N 次 pi mcp list）", () => {
  useMcpStore.getState().setServers({
    servers: [
      { name: "alpha", command: "echo", state: "connected" },
      { name: "beta", command: "echo", state: "failed" },
    ],
  });
  expect(useMcpStore.getState().testingServers).toEqual({});
  expect(calls).toEqual([]);
});

// ===== 保存 / 删除 =====

test("save 成功返回 ok:true 并带 projectId 与 originalName", async () => {
  const result = await useMcpStore
    .getState()
    .save({ name: "new", command: "npx" }, "p1", "old");
  expect(result).toEqual({ ok: true });
  expect(calls[0]).toEqual({
    method: "POST",
    path: "/api/mcp",
    body: {
      projectId: "p1",
      config: { name: "new", command: "npx" },
      originalName: "old",
    },
  });
});

test("save 的 400 字段级 errors 透传给调用方（供表单绑字段）", async () => {
  postImpl = () =>
    Promise.reject(
      Object.assign(new Error("服务器名非法"), {
        errors: [{ field: "name", message: "只允许字母、数字、下划线与连字符" }],
      }),
    );
  const result = await useMcpStore
    .getState()
    .save({ name: "bad name!", command: "npx" });
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual([
    { field: "name", message: "只允许字母、数字、下划线与连字符" },
  ]);
});

test("save 的其它错误走 code 字典渲染的整体文案", async () => {
  postImpl = () =>
    Promise.reject(
      Object.assign(new Error("mcp.originalServerNotFound"), {
        failure: {
          code: "mcp.originalServerNotFound",
          params: { name: "old" },
        },
      }),
    );
  const result = await useMcpStore
    .getState()
    .save({ name: "new", command: "npx" }, undefined, "old");
  expect(result.ok).toBe(false);
  expect(result.errors).toBeUndefined();
  expect(result.message).toContain("old");
  expect(result.message).not.toContain("mcp.originalServerNotFound");
});

test("deleteServer 打 DELETE 端点（带作用域）且不本地删除（由回推刷新）", async () => {
  useMcpStore.setState({
    servers: [{ name: "to-delete", command: "echo" }],
  });
  await useMcpStore.getState().deleteServer("to-delete", "p1");
  expect(useMcpStore.getState().servers).toHaveLength(1);
  expect(calls[0]).toEqual({
    method: "DELETE",
    path: "/api/mcp/to-delete?projectId=p1",
  });
});

test("deleteServer 失败不静默（弹错误提示）", async () => {
  delImpl = () =>
    Promise.reject(
      Object.assign(new Error("MCP 服务器 x 不存在"), {
        failure: { code: "mcp.serverNotFound", params: { name: "x" } },
      }),
    );
  await useMcpStore.getState().deleteServer("x");
  const toasts = useToastStore.getState().toasts;
  expect(toasts).toHaveLength(1);
  expect(toasts[0].type).toBe("error");
});

// ===== 项目级作用域开关 =====

test("setProjectMcpScope 写 trust.json 端点并重读当前作用域清单", async () => {
  useMcpStore.setState({ selectedProjectId: "p1" });
  await useMcpStore.getState().setProjectMcpScope("p1", true);
  expect(calls[0]).toEqual({
    method: "POST",
    path: "/api/mcp/project-scope",
    body: { projectId: "p1", enabled: true },
  });
  expect(calls[1]).toEqual({ method: "GET", path: "/api/mcp?projectId=p1" });
});

test("setProjectMcpScope 关闭时传 enabled:false（不被真值判断吞掉）", async () => {
  useMcpStore.setState({ selectedProjectId: "p1" });
  await useMcpStore.getState().setProjectMcpScope("p1", false);
  expect(calls[0].body).toEqual({ projectId: "p1", enabled: false });
});

test("setProjectMcpScope 被拒（__system__ → 400）时提示且不重读清单", async () => {
  postImpl = () =>
    Promise.reject(
      Object.assign(new Error("默认工作区不支持项目级 MCP 作用域开关"), {
        failure: { code: "mcp.systemProject" },
      }),
    );
  await useMcpStore.getState().setProjectMcpScope("__system__", true);
  expect(useToastStore.getState().toasts).toHaveLength(1);
  expect(calls.filter((c) => c.method === "GET")).toEqual([]);
});

// ===== 搜索 / 作用域选择 =====

test("setSearchQuery / setSelectedProjectId 更新本地状态", () => {
  useMcpStore.getState().setSearchQuery("figma");
  expect(useMcpStore.getState().searchQuery).toBe("figma");

  useMcpStore.getState().setSelectedProjectId("p2");
  expect(useMcpStore.getState().selectedProjectId).toBe("p2");

  useMcpStore.getState().setSelectedProjectId(null);
  expect(useMcpStore.getState().selectedProjectId).toBeNull();
});

// ===== 项目级开关的真值回读（缺口①：不能靠 pi 的 note 反推）=====

test("loadProjectScope 回读 trust.json 的真值：true / false 原样、null 表示未设置", async () => {
  useMcpStore.setState({ selectedProjectId: "p1" });

  getImpl = () => Promise.resolve({ enabled: true });
  await useMcpStore.getState().loadProjectScope("p1");
  expect(calls[0]).toEqual({
    method: "GET",
    path: "/api/mcp/project-scope?projectId=p1",
  });
  expect(useMcpStore.getState().projectScopeEnabled).toBe(true);

  getImpl = () => Promise.resolve({ enabled: false });
  await useMcpStore.getState().loadProjectScope("p1");
  expect(useMcpStore.getState().projectScopeEnabled).toBe(false);

  // 未显式设置（kernel 回 null）→ 保留 null，前端显示「未设置 / 跟随上层」
  getImpl = () => Promise.resolve({ enabled: null });
  await useMcpStore.getState().loadProjectScope("p1");
  expect(useMcpStore.getState().projectScopeEnabled).toBeNull();
});

test("loadProjectScope 读失败（网络 / 500）不谎报「已开」：归为「未设置」", async () => {
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: true });
  getImpl = () => Promise.reject(new Error("boom"));
  await useMcpStore.getState().loadProjectScope("p1");
  // 读不到真值 → 归 null（安全侧：不把受信显示成已开）
  expect(useMcpStore.getState().projectScopeEnabled).toBeNull();
});

test("loadProjectScope 的晚到回包不覆盖已切走的项目", async () => {
  let resolveGet: (v: unknown) => void = () => {};
  getImpl = () =>
    new Promise((resolve) => {
      resolveGet = resolve;
    });
  useMcpStore.setState({ selectedProjectId: "p1" });
  const pending = useMcpStore.getState().loadProjectScope("p1");
  // 响应回来前用户切到另一个项目
  useMcpStore.getState().setSelectedProjectId("p2");
  resolveGet({ enabled: true });
  await pending;
  expect(useMcpStore.getState().projectScopeEnabled).toBeNull();
});

test("setSelectedProjectId 切换时清空真值：不把上一个项目的开关态显示给新项目", () => {
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: true });
  useMcpStore.getState().setSelectedProjectId("p2");
  expect(useMcpStore.getState().projectScopeEnabled).toBeNull();
});

test("切换作用域清空本会话的测试结果：同名 server 不继承另一作用域的状态与工具数", () => {
  useMcpStore.setState({
    selectedProjectId: null,
    serverStatuses: { dbx: "connected" },
    toolCounts: { dbx: 7 },
    errors: { dbx: "全局作用域里的失败原因" },
    toolsCache: { dbx: [{ name: "global_tool" }] },
  });
  useMcpStore.getState().setSelectedProjectId("p1");
  const s = useMcpStore.getState();
  // 这些表按 serverName 键控、没有作用域前缀：不清空就会把全局那台 dbx 的结果显示在项目里
  expect(s.serverStatuses).toEqual({});
  expect(s.toolCounts).toEqual({});
  expect(s.errors).toEqual({});
  expect(s.toolsCache).toEqual({});
});

test("setProjectMcpScope 成功后就地更新真值（不等下一次回读）", async () => {
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: false });
  await useMcpStore.getState().setProjectMcpScope("p1", true);
  expect(useMcpStore.getState().projectScopeEnabled).toBe(true);
});

test("setProjectMcpScope 失败（400）时真值保持不变，只提示", async () => {
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: false });
  postImpl = () =>
    Promise.reject(
      Object.assign(new Error("默认工作区不支持项目级 MCP 作用域开关"), {
        failure: { code: "mcp.systemProject" },
      }),
    );
  await useMcpStore.getState().setProjectMcpScope("p1", true);
  expect(useMcpStore.getState().projectScopeEnabled).toBe(false);
  expect(useToastStore.getState().toasts).toHaveLength(1);
});
