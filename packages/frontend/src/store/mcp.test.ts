// MCP store 清单装载的**新鲜度**回归测试（任务 13 报告 §2 的根因）。
//
// bug：`load()` 的 `GET /api/mcp` 是冷路径（内核要真 spawn `pi mcp list`，实测 6~7s），
// 而写操作后的 `mcp:changed` 广播在写盘后立刻发出。两者走不同连接，**先发出的请求可能后到达**：
// 把这份「改动前读到的清单」当最新写入 store，用户刚添加的服务器就从界面上消失，
// 且没有任何后续刷新把它带回来（E2E `mcp-connector.spec.ts` 的卡片断言因此 30s 超时）。
import { beforeEach, expect, mock, test } from "bun:test";

/** 可控的 api.get：每个用例自己决定何时、以什么值 resolve（模拟「响应还在飞」） */
const pending: Array<(v: unknown) => void> = [];
const getMock = mock(() => new Promise<unknown>((resolve) => pending.push(resolve)));
mock.module("../api-client", () => ({
  // 运行时导入点会取同名导出，缺了会 SyntaxError
  ApiError: class ApiError extends Error {},
  api: {
    get: getMock,
    post: async () => ({}),
    put: async () => ({}),
    del: async () => ({}),
  },
}));

const { useMcpStore } = await import("./mcp");

/** 造一条清单条目（只需 name/state 供断言） */
const entry = (name: string) => ({
  name,
  command: "bun",
  exposure: "direct",
  state: "connected",
}) as never;

/** 造一份 REST 清单回包（listWithState 的形状） */
const listPayload = (names: string[]) => ({
  servers: names.map((n) => entry(n)),
  errors: [],
  commandFailed: false,
  hasProblems: false,
  stale: false,
});

/** 让已 resolve 的 promise 的 .then 跑完 */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  pending.length = 0;
  useMcpStore.setState({
    servers: [],
    stale: false,
    note: undefined,
    selectedProjectId: null,
    loading: false,
  });
});

test("先发出的 GET /api/mcp 响应后到达时，不得覆盖之后到达的 mcp:changed 广播", async () => {
  useMcpStore.getState().load(); // 冷路径请求发出（响应还没回来）
  expect(getMock).toHaveBeenCalledTimes(1);

  // 请求还在飞：写操作成功 → 广播带着新清单到达
  useMcpStore
    .getState()
    .setServers({ type: "mcp:changed", servers: [entry("e2e")] } as never);
  expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(["e2e"]);

  // 过期响应（改动前读到的空清单）后到达
  pending[0](listPayload([]));
  await flush();

  expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(["e2e"]);
  expect(useMcpStore.getState().loading).toBe(false);
});

test("对照：没有更新的来源介入时，GET 响应正常写入清单", async () => {
  useMcpStore.getState().load();
  pending[0](listPayload(["e2e"]));
  await flush();
  expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(["e2e"]);
});

test("对照：作用域不匹配的过期响应仍被丢弃（既有作用域守卫不回归）", async () => {
  useMcpStore.getState().load("proj-1"); // 请求项目作用域
  useMcpStore.getState().setSelectedProjectId(null); // 用户切回全局
  pending[0](listPayload(["proj-server"]));
  await flush();
  expect(useMcpStore.getState().servers).toEqual([]);
});

test("对照：别的作用域的事件（被作用域守卫拒绝）不得作废本作用域在飞的清单请求", async () => {
  useMcpStore.getState().load(); // 全局作用域，响应在飞
  // 项目作用域的事件：作用域不符 → 丢弃；但它**不能**把在飞的全局请求判成过期
  useMcpStore.getState().setServers({
    type: "mcp:changed",
    projectId: "proj-1",
    servers: [entry("proj-server")],
  } as never);
  expect(useMcpStore.getState().servers).toEqual([]);

  pending[0](listPayload(["global-server"]));
  await flush();
  expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual([
    "global-server",
  ]);
});
