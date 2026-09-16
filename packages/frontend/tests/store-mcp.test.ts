import { test, expect, beforeEach, mock } from "bun:test";
import { useMcpStore } from "../src/store/mcp";

// store 的 load/testConnection 等会触发 api.get/post（真实 fetch），
// happy-dom 在 about:blank 下对相对 URL 抛 NotSupportedError。mock 掉 api-client，
// 返回空数据，让 store 的 .then/.catch 正常走，断言聚焦于 state 变更。
mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve(null),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

beforeEach(() => {
  useMcpStore.setState({
    servers: [],
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    serverStatuses: {},
    toolCounts: {},
    toolsCache: {},
    loadingTools: {},
    testingServers: {},
    autoTestedProject: undefined,
    errors: {},
  });
});

test("load 发起 mcp:list 请求", () => {
  useMcpStore.getState().load();
  expect(useMcpStore.getState().loading).toBe(true);
});

test("load 带 projectId 更新 selectedProjectId", () => {
  useMcpStore.getState().load("p1");
  expect(useMcpStore.getState().selectedProjectId).toBe("p1");
  expect(useMcpStore.getState().loading).toBe(true);
});

test("setServers 更新 servers 并清除 loading", () => {
  useMcpStore.getState().load();
  useMcpStore.getState().setServers({
    type: "mcp:list",
    servers: [{ name: "test", command: "echo" }],
  });
  expect(useMcpStore.getState().servers).toEqual([
    { name: "test", command: "echo" },
  ]);
  expect(useMcpStore.getState().loading).toBe(false);
});

test("setServers 也处理 mcp:changed 事件", () => {
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    servers: [{ name: "changed-svr", url: "http://localhost:3845/mcp" }],
  });
  expect(useMcpStore.getState().servers).toEqual([
    { name: "changed-svr", url: "http://localhost:3845/mcp" },
  ]);
});

test("setTestResult 成功更新状态为 connected", () => {
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "test",
    success: true,
  });
  expect(useMcpStore.getState().serverStatuses["test"]).toBe("connected");
});

test("setTestResult 失败更新状态为 error", () => {
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "test",
    success: false,
    error: "连接失败",
  });
  expect(useMcpStore.getState().serverStatuses["test"]).toBe("error");
});

test("setTestResult 携带 status 时优先用 status，并记录 toolCount", () => {
  // connected + toolCount
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

test("setToolsResult 更新 tools cache", () => {
  useMcpStore.getState().setToolsResult({
    type: "mcp:tools",
    serverName: "test",
    tools: [{ name: "tool_a", description: "A tool" }],
  });
  expect(useMcpStore.getState().toolsCache["test"]).toEqual([
    { name: "tool_a", description: "A tool" },
  ]);
});

test("listTools 标记 loadingTools 为加载中", () => {
  useMcpStore.getState().listTools("dbx", "p1");
  expect(useMcpStore.getState().loadingTools["dbx"]).toBe(true);
});

test("setToolsResult 清除 loadingTools 并缓存工具", () => {
  useMcpStore.getState().listTools("dbx", "p1");
  expect(useMcpStore.getState().loadingTools["dbx"]).toBe(true);
  useMcpStore.getState().setToolsResult({
    type: "mcp:tools",
    serverName: "dbx",
    tools: [{ name: "tool_a", description: "A tool" }],
  });
  expect(useMcpStore.getState().loadingTools["dbx"]).toBe(false);
  expect(useMcpStore.getState().toolsCache["dbx"]).toEqual([
    { name: "tool_a", description: "A tool" },
  ]);
});

test("setSearchQuery 更新搜索查询", () => {
  useMcpStore.setState({
    servers: [
      { name: "chrome-devtools", command: "npx" },
      { name: "figma", url: "http://localhost:3845/mcp" },
      { name: "linear", command: "npx" },
    ],
  });
  useMcpStore.getState().setSearchQuery("figma");
  expect(useMcpStore.getState().searchQuery).toBe("figma");
});

test("setSelectedProjectId 更新项目选择", () => {
  useMcpStore.getState().setSelectedProjectId("p2");
  expect(useMcpStore.getState().selectedProjectId).toBe("p2");

  useMcpStore.getState().setSelectedProjectId(null);
  expect(useMcpStore.getState().selectedProjectId).toBeNull();
});

test("deleteServer 发起 mcp:delete WS 请求且不修改本地 state", () => {
  useMcpStore.setState({
    servers: [{ name: "to-delete", command: "echo" }],
  });
  useMcpStore.getState().deleteServer("to-delete", "p1");
  // deleteServer 只发送 WS 消息，不本地删除 — 由 mcp:changed 回推驱动
  expect(useMcpStore.getState().servers).toHaveLength(1);
});

test("testConnection 标记 testingServers 并清除旧错误", () => {
  useMcpStore.setState({ errors: { dbx: "上次失败" } });
  useMcpStore.getState().testConnection("dbx");
  expect(useMcpStore.getState().testingServers["dbx"]).toBe(true);
  expect(useMcpStore.getState().errors["dbx"]).toBeUndefined();
});

test("setTestResult 成功时清除 testingServers 标记", () => {
  useMcpStore.getState().testConnection("dbx");
  expect(useMcpStore.getState().testingServers["dbx"]).toBe(true);
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "dbx",
    success: true,
  });
  expect(useMcpStore.getState().testingServers["dbx"]).toBeUndefined();
  expect(useMcpStore.getState().serverStatuses["dbx"]).toBe("connected");
});

test("setTestResult 失败时清除 testingServers 标记并记录错误信息", () => {
  useMcpStore.getState().testConnection("dbx");
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "dbx",
    success: false,
    error: "pi-mcp-adapter 未安装",
  });
  expect(useMcpStore.getState().testingServers["dbx"]).toBeUndefined();
  expect(useMcpStore.getState().serverStatuses["dbx"]).toBe("error");
  expect(useMcpStore.getState().errors["dbx"]).toBe("pi-mcp-adapter 未安装");
});

// ===== 自动连接测试：切换项目作用域后自动对每个服务器发起连接测试 =====
// 以可观测的 store 状态断言（每个服务器进入 testingServers + autoTestedProject 记账），
// 而非 WS send spy——后者在全量套件共享进程时受模块/全局解析影响不稳定。

test("切换到新项目作用域后 setServers 自动对每个服务器发起连接测试", () => {
  useMcpStore.setState({ selectedProjectId: "p1", autoTestedProject: "p1" });
  // 切到 p2：load 设 selectedProjectId=p2，随后内核回推 mcp:list → setServers
  useMcpStore.getState().load("p2");
  useMcpStore.getState().setServers({
    type: "mcp:list",
    servers: [
      { name: "alpha", command: "echo" },
      { name: "beta", command: "echo" },
    ],
  });

  // 每个服务器都进入测试中状态（这正是 McpCard 渲染「测试中...」所读的状态）
  expect(useMcpStore.getState().testingServers).toEqual({
    alpha: true,
    beta: true,
  });
  // 记录已对该作用域自动测过
  expect(useMcpStore.getState().autoTestedProject).toBe("p2");
});

test("同一项目作用域重复刷新（如 mcp:changed）不重复自动测试", () => {
  useMcpStore.setState({
    selectedProjectId: "p1",
    autoTestedProject: "p1",
    testingServers: {},
  });
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    servers: [{ name: "alpha", command: "echo" }],
  });
  // 作用域未变 → 不触发自动测试，testingServers 保持空、autoTestedProject 不变
  expect(useMcpStore.getState().testingServers).toEqual({});
  expect(useMcpStore.getState().autoTestedProject).toBe("p1");
});

test("作用域无服务器时不发起自动测试", () => {
  useMcpStore.setState({
    selectedProjectId: "p1",
    autoTestedProject: undefined,
    testingServers: {},
  });
  useMcpStore.getState().setServers({ type: "mcp:list", servers: [] });
  expect(useMcpStore.getState().testingServers).toEqual({});
  expect(useMcpStore.getState().autoTestedProject).toBeUndefined();
});
