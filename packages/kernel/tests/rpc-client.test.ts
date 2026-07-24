// rpc-client 单元测试：用 tests/fixtures/fake-pi.ts 作为假 pi 进程，
// 验证 JSONL 协议（id 关联 / 事件分发 / UI 子协议 / U+2028 断行 / 超时 / 进程退出）。
import { test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, buildPiArgs, resolvePiCliPath, type RpcEvent, type RpcUiRequest } from "../src/rpc-client";

const FAKE_PI = join(import.meta.dir, "fixtures", "fake-pi.ts");

const clients: RpcClient[] = [];

function makeClient(extra: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}) {
  const events: RpcEvent[] = [];
  const client = new RpcClient({
    cliPath: FAKE_PI,
    runtime: process.execPath, // 测试跑在 bun 下，execPath 即可执行文件
    cwd: import.meta.dir,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  clients.push(client);
  return { client, events };
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.dispose().catch(() => {});
  }
});

test("get_state 返回响应数据", async () => {
  const { client } = makeClient();
  await client.start();
  const state = await client.getState();
  expect(state.isStreaming).toBe(false);
  expect(state.thinkingLevel).toBe("medium");
});

test("prompt 响应后事件按序流入 onEvent", async () => {
  const { client, events } = makeClient();
  await client.start();
  await client.prompt("你好");
  // prompt 响应只代表「已受理」，事件流异步到达，等一拍再断言
  await new Promise((r) => setTimeout(r, 100));
  const types = events.map((e) => e.type);
  expect(types).toEqual(["agent_start", "message_update", "message_end", "agent_end", "agent_settled"]);
  const update = events[1];
  expect(update.assistantMessageEvent.delta).toBe("回声:你好");
});

test("success:false 的命令 reject 并带 error 文本", async () => {
  const { client } = makeClient();
  await client.start();
  await expect(client.command({ type: "fail_me" })).rejects.toThrow("故意失败");
});

test("命令超时 reject（不杀进程，后续命令仍可用）", async () => {
  const { client } = makeClient({ commandTimeoutMs: 200 });
  await client.start();
  await expect(client.command({ type: "slow" })).rejects.toThrow("超时");
  // 超时后进程仍存活，能继续响应
  const state = await client.getState();
  expect(state.isStreaming).toBe(false);
});

test("extension_ui_request 对话类方法：onUiRequest 返回值写回 pi", async () => {
  const uiRequests: RpcUiRequest[] = [];
  const { client } = makeClient({
    onUiRequest: async (req) => {
      uiRequests.push(req);
      return { value: "A" };
    },
  });
  await client.start();
  const data = await client.command({ type: "ui_select" });
  expect(uiRequests).toHaveLength(1);
  expect(uiRequests[0].method).toBe("select");
  expect(data.echo.value).toBe("A");
});

test("extension_ui_request：无 handler 时自动回 cancelled", async () => {
  const { client } = makeClient();
  await client.start();
  const data = await client.command({ type: "ui_select" });
  expect(data.echo.cancelled).toBe(true);
});

test("fire-and-forget UI 请求（notify）不阻塞、不要求响应", async () => {
  const { client } = makeClient({
    onUiRequest: async () => {
      throw new Error("不应被调用");
    },
  });
  await client.start();
  await client.command({ type: "ui_notify" });
});

test("stdout 行内 U+2028/U+2029 不造成错误断行", async () => {
  const { client } = makeClient();
  await client.start();
  const data = await client.command({ type: "unicode" });
  expect(data.text).toBe("甲 乙 丙");
});

test("进程退出时 pending 命令 reject 并触发 onExit", async () => {
  let exitCode: number | null = null;
  const { client } = makeClient({
    commandTimeoutMs: 5000,
    onExit: (code) => {
      exitCode = code;
    },
  });
  await client.start();
  const slowPromise = client.command({ type: "slow" });
  const diePromise = client.command({ type: "die" });
  // 用 .then 同步挂 handler 捕获结果：进程退出瞬间两个 promise 同时 reject，
  // expect().rejects 逐个 await 会让后挂的那个被 bun 判为 unhandled rejection
  const [slowResult, dieResult] = await Promise.all([
    slowPromise.then(() => "resolved", (e: Error) => e.message),
    diePromise.then(() => "resolved", (e: Error) => e.message),
  ]);
  expect(dieResult).toContain("退出");
  expect(slowResult).toContain("退出");
  // onExit 在 exit 事件里同步触发（TS 控制流会把 exitCode 窄化为 null，显式还原声明类型）
  expect(exitCode as number | null).toBe(3);
  expect(client.isAlive()).toBe(false);
});

test("buildPiArgs 按规格生成参数", () => {
  const args = buildPiArgs({
    sessionFile: "/tmp/s.jsonl",
    systemPromptFile: "/tmp/prompt.md",
    extensionPaths: ["/ext/a.ts", "/ext/b.ts"],
    skillPaths: ["/skills/x"],
    tools: ["read", "bash"],
    thinking: "high",
    model: "anthropic/claude-sonnet-4-5",
    name: "s1",
    offline: true,
    noContextFiles: true,
  });
  expect(args).toEqual([
    "--session", "/tmp/s.jsonl",
    "--system-prompt", "/tmp/prompt.md",
    "-e", "/ext/a.ts", "-e", "/ext/b.ts",
    "--skill", "/skills/x",
    "--tools", "read,bash",
    "--thinking", "high",
    "--model", "anthropic/claude-sonnet-4-5",
    "--name", "s1",
    "--offline",
    "--no-context-files",
  ]);
});

test("buildPiArgs：空 tools 不传 --tools，noSession 生效", () => {
  const args = buildPiArgs({ noSession: true, tools: [] });
  expect(args).toEqual(["--no-session"]);
});

test("resolvePiCliPath 能定位真实 pi CLI", () => {
  const cliPath = resolvePiCliPath();
  expect(cliPath.endsWith(join("dist", "cli.js"))).toBe(true);
  expect(existsSync(cliPath)).toBe(true);
});

test("集成：真实 pi --mode rpc 响应 get_state（offline）", async () => {
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    runtime: process.execPath,
    args: buildPiArgs({ noSession: true, offline: true }),
    cwd: import.meta.dir,
    env: { PI_CODING_AGENT_DIR: join(import.meta.dir, "fixtures", "pi-agent-dir-test") },
    onEvent: () => {},
  });
  clients.push(client);
  await client.start();
  const state = await client.getState();
  expect(typeof state.sessionId).toBe("string");
  expect(state.isStreaming).toBe(false);
});
