// store/mcp 回归测试：
// ① applyProbe（mcp:probe 逐台探测结果）按台更新 + 作用域过滤；
// ② testConnection 的看门狗——广播丢失/请求挂死时「测试中」到点强制复位，不再永久转圈。
// 说明：kernel 侧的探测器与路由为 TDD 先红后绿（见 kernel __tests__）；本文件是前端侧回归锁定。
import { test, expect, mock, beforeEach, afterEach, jest } from "bun:test";

// ---- 模块 mock（在 import store 之前注册） ----
const postCalls: { url: string; body: unknown }[] = [];
mock.module("../api-client", () => ({
  MCP_RPC_TIMEOUT_MS: 80_000,
  api: {
    get: async () => ({ servers: [] }),
    post: (async (url: string, body: unknown) => {
      postCalls.push({ url, body });
      // 挂住不返回：模拟 kernel 广播丢失 / HTTP 请求挂死
      await new Promise<void>(() => {});
    }) as unknown,
    del: async () => ({}),
  },
}));
mock.module("../i18n", () => ({
  default: { t: (key: string) => key },
}));
mock.module("./toast", () => ({
  useToastStore: { getState: () => ({ add: () => {} }) },
}));

const { useMcpStore } = await import("./mcp");

beforeEach(() => {
  jest.useFakeTimers();
  postCalls.length = 0;
  useMcpStore.setState({
    servers: [
      { name: "dbx", type: "stdio", command: "/x" },
      { name: "hlk", type: "http", url: "http://127.0.0.1:1/mcp" },
    ] as any,
    testingServers: {},
    errors: {},
    toolCounts: {},
    selectedProjectId: null,
    stale: false,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test("applyProbe 按台更新探测状态与工具，不触碰其他台", () => {
  useMcpStore.getState().applyProbe({
    type: "mcp:probe",
    serverName: "dbx",
    state: "connected",
    tools: ["a", "b"],
  } as any);
  const servers = useMcpStore.getState().servers;
  expect(servers.find((s) => s.name === "dbx")?.state).toBe("connected");
  expect(servers.find((s) => s.name === "dbx")?.tools).toEqual(["a", "b"]);
  expect(servers.find((s) => s.name === "hlk")?.state).toBeUndefined();
});

test("applyProbe 丢弃作用域不符的进度", () => {
  useMcpStore.getState().applyProbe({
    type: "mcp:probe",
    projectId: "other-project",
    serverName: "dbx",
    state: "connected",
    tools: [],
  } as any);
  expect(useMcpStore.getState().servers.find((s) => s.name === "dbx")?.state).toBeUndefined();
});

test("看门狗：结果永不到达时，「测试中」到点强制复位并提示超时", () => {
  useMcpStore.getState().testConnection("dbx", undefined);
  expect(useMcpStore.getState().testingServers["dbx"]).toBe(true);
  // 请求已发出
  expect(postCalls.length).toBe(1);
  expect(postCalls[0]!.url).toBe("/api/mcp/test");

  // 快进越过看门狗（60s）：测试态被强制复位 + 错误提示
  jest.advanceTimersByTime(61_000);
  expect(useMcpStore.getState().testingServers["dbx"]).toBeUndefined();
  expect(useMcpStore.getState().errors["dbx"]).toBe("store.mcpProbeTimeout");
});

test("正常结果到达：撤看门狗、复位「测试中」、到点也不误报超时", () => {
  useMcpStore.getState().testConnection("dbx", undefined);
  useMcpStore.getState().setTestResult({
    type: "mcp:testResult",
    serverName: "dbx",
    success: true,
    status: "connected",
    toolCount: 3,
  } as any);
  expect(useMcpStore.getState().testingServers["dbx"]).toBeUndefined();
  expect(useMcpStore.getState().toolCounts["dbx"]).toBe(3);

  // 快进越过原看门狗时限：不误报（看门狗已被正常结果撤掉）
  jest.advanceTimersByTime(61_000);
  expect(useMcpStore.getState().errors["dbx"]).toBeUndefined();
  expect(useMcpStore.getState().testingServers["dbx"]).toBeUndefined();
});
