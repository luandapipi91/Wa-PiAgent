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
