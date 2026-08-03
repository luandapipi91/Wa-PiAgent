/**
 * 扩展命令域路由测试（阶段二·去 WS 化）
 *
 * 覆盖任务 5 新增的两个 API：
 * - GET  /api/extensions/commands            → 命令列表 + 开关状态合并（extension:commands:list）
 * - POST /api/extensions/commands/toggle     → 切换命令开关（extension:commands:toggle）
 *
 * 使用真实 HTTP 请求打 WSServer（port 0 随机端口），agentManager / extensionManager
 * 用可配置 spy 桩：list 断言命令与开关状态合并结果，toggle 断言 setCommandToggle 调用参数
 * 与 resetCommandState 联动，非法参数断言 400。
 */
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { WSServer } from "../src/ws-server";

// 可配置 spy 桩：每个测试通过 mockImplementation 覆盖行为
const getCommandsSpy = mock(async (): Promise<any[]> => []);
const getCommandTogglesSpy = mock(async () => ({}));
const setCommandToggleSpy = mock(async () => {});
const resetCommandStateSpy = mock(() => {});

/** 最小 agentManager 桩：仅满足 WSServer 构造与 list/toggle 两条链路 */
function makeAgentManager() {
  return {
    getCommands: getCommandsSpy,
    resetCommandState: resetCommandStateSpy,
    disposeAll: async () => {},
    onEvent: () => {},
  };
}

/** 最小 extensionManager 桩：仅满足命令 list/toggle 链路 */
function makeExtensionManager() {
  return {
    getCommandToggles: getCommandTogglesSpy,
    setCommandToggle: setCommandToggleSpy,
  };
}

/** 最小 projectStore 桩：仅满足 WSServer 构造 */
function makeProjectStore() {
  return { load: async () => ({ projects: [], sessions: [] }) };
}

let server: WSServer;
let base: string;

beforeAll(async () => {
  server = new WSServer({
    agentManager: makeAgentManager() as any,
    extensionManager: makeExtensionManager() as any,
    projectStore: makeProjectStore() as any,
    // 本测试不涉及的 store/manager：空桩满足 WSServerOpts 结构
    configStore: {} as any,
    providerStore: {} as any,
    skillManager: {} as any,
    memoryStore: {} as any,
    mcpStore: {} as any,
    port: 0, // 随机端口
  });
  await server.start();
  base = `http://localhost:${server.actualPort}`;
});

afterAll(async () => {
  server?.stop();
});

test("GET /api/extensions/commands 返回 { commands: [] } 结构（无命令时）", async () => {
  getCommandsSpy.mockImplementation(async () => []);
  getCommandTogglesSpy.mockImplementation(async () => ({}));

  const res = await fetch(`${base}/api/extensions/commands`);
  expect(res.status).toBe(200);
  const body = await res.json();
  // 结构断言：HTTP 响应体即 handler 的最后一个 reply
  expect(body.type).toBe("extension:commands:list");
  expect(Array.isArray(body.commands)).toBe(true);
  expect(body.commands).toEqual([]);
  // list 链路确实借用了 agentManager.getCommands（空 sessionId 借用活跃进程）
  expect(getCommandsSpy).toHaveBeenCalledWith("");
});

test("GET /api/extensions/commands 合并开关状态（按 packageName 匹配，缺省 false）", async () => {
  getCommandsSpy.mockImplementation(async () => [
    { name: "goal", description: "设定目标", source: "extension", packageName: "pkg-a" },
    { name: "hello", source: "extension", packageName: "pkg-b" },
    { name: "review", description: "代码审查模板", source: "prompt" },
  ]);
  getCommandTogglesSpy.mockImplementation(async () => ({
    "pkg-a": { goal: true },
  }));

  const res = await fetch(`${base}/api/extensions/commands`);
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.commands).toHaveLength(3);
  // 有 packageName → 合并 toggles（命中 → 用开关值）
  expect(body.commands[0]).toEqual({
    name: "goal",
    description: "设定目标",
    source: "extension",
    packageName: "pkg-a",
    enabled: true,
  });
  // 有 packageName 但 toggles 无记录 → 缺省 false
  expect(body.commands[1]).toEqual({
    name: "hello",
    source: "extension",
    packageName: "pkg-b",
    enabled: false,
  });
  // 无 packageName（prompt 来源）→ 原样透传，不附加 enabled
  expect(body.commands[2]).toEqual({
    name: "review",
    description: "代码审查模板",
    source: "prompt",
  });
});

test("POST /api/extensions/commands/toggle 成功 → 调 setCommandToggle + 重置命令状态", async () => {
  setCommandToggleSpy.mockClear();
  resetCommandStateSpy.mockClear();

  const res = await fetch(`${base}/api/extensions/commands/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageName: "pkg-a", command: "goal", enabled: false }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    type: "extension:commands:toggle",
    ok: true,
  });
  // 正确透传 packageName/command/enabled 到 ExtensionManager
  expect(setCommandToggleSpy).toHaveBeenCalledWith("pkg-a", "goal", false);
  // toggle 后必须重置降级集合（_commandsFetched=false + resetDisabledCommands）
  expect(resetCommandStateSpy).toHaveBeenCalledTimes(1);
});

test("POST /api/extensions/commands/toggle 缺 packageName → 400", async () => {
  setCommandToggleSpy.mockClear();
  const res = await fetch(`${base}/api/extensions/commands/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "goal", enabled: true }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("参数缺失或类型错误");
  expect(setCommandToggleSpy).not.toHaveBeenCalled();
});

test("POST /api/extensions/commands/toggle 缺 command → 400", async () => {
  setCommandToggleSpy.mockClear();
  const res = await fetch(`${base}/api/extensions/commands/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageName: "pkg-a", enabled: true }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("参数缺失或类型错误");
});

test("POST /api/extensions/commands/toggle enabled 非 boolean → 400", async () => {
  setCommandToggleSpy.mockClear();
  const res = await fetch(`${base}/api/extensions/commands/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageName: "pkg-a", command: "goal", enabled: "yes" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("参数缺失或类型错误");
  expect(setCommandToggleSpy).not.toHaveBeenCalled();
});
