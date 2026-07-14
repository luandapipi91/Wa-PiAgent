import { test, expect, beforeEach } from "bun:test";
import { useMcpStore } from "../src/store/mcp";

beforeEach(() => {
  useMcpStore.setState({
    servers: [],
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    serverStatuses: {},
    toolsCache: {},
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
  expect(useMcpStore.getState().servers).toEqual([{ name: "test", command: "echo" }]);
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
