import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PiRpcClient } from "../src/pi-rpc-client";
import type { PiEvent } from "../src/pi-rpc-client";
import type { AgentName } from "@hiagent/shared";

// mock 子进程：模拟 pi --mode rpc 的 stdin/stdout JSONL
function mockSpawn() {
  let stdoutBuf = "";
  const stdout = new EventEmitter();
  let lastArgs: string[] = [];
  const child = {
    stdin: { write: (s: string) => { stdoutBuf += s; }, end: () => {} },
    stdout,
    stderr: new EventEmitter(),
    killed: false,
    kill: () => { child.killed = true; },
    emitLine: (obj: unknown) => stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n")),
    getStdoutBuf: () => stdoutBuf,
    resetStdoutBuf: () => { stdoutBuf = ""; },
    getLastArgs: () => lastArgs,
  };
  // 返回一个包装函数，记录 args
  (child as any).__spawnFn = (_cmd: string, args: string[]) => { lastArgs = args; return child; };
  return child;
}

test("start 发 get_state 握手", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  expect(mock.getStdoutBuf()).toContain("get_state");
  await client.dispose();
});

test("prompt 写入 stdin", async () => {
  const mock = mockSpawn();
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: () => {},
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.resetStdoutBuf();
  await client.prompt("你好");
  expect(mock.getStdoutBuf()).toContain("prompt");
  expect(mock.getStdoutBuf()).toContain("你好");
  await client.dispose();
});

test("onEvent 收 message_end → assistant message 事件", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  // pi 0.80 协议：message_end 时 message.content 含 type:text 元素
  mock.emitLine({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "你好" }, { type: "thinking", thinking: "思考" }],
    },
  });
  const ev = events.find(e => e.kind === "message");
  expect(ev).toBeDefined();
  expect(ev && ev.kind === "message" && ev.message.text).toBe("你好");
  expect(ev && ev.kind === "message" && ev.message.role).toBe("assistant");
  await client.dispose();
});

test("onEvent 收 state 变化", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.emitLine({ type: "state_change", state: { status: "thinking" } });
  const ev = events.find(e => e.kind === "state");
  expect(ev && ev.kind === "state" && ev.state.status).toBe("thinking");
  await client.dispose();
});

test("start 根据 config 传 --system-prompt/--tools/--model", async () => {
  const mock = mockSpawn();
  const capturedArgs: string[] = [];
  const config: import("@hiagent/shared").AgentConfig = {
    name: "dev", displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
    description: "技术", model: "deepseek/deepseek-v4-flash",
    thinking: "high", systemPromptMode: "replace", inheritProjectContext: true,
    inheritSkills: false, tools: ["read", "bash", "intercom"], skills: [], mcpServers: [],
    partners: { askTo: [], askFrom: [] }, systemPromptBody: "你是资深工程师",
  };
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: () => {},
    config,
    spawnFn: (_cmd: string, args: string[]) => { capturedArgs.push(...args); return mock as any; },
  });
  await client.start();
  expect(capturedArgs).toContain("--system-prompt");
  expect(capturedArgs).toContain("你是资深工程师");
  expect(capturedArgs.some((a, i) => a === "--tools" && capturedArgs[i+1]?.includes("read"))).toBe(true);
  expect(capturedArgs.some((a, i) => a === "--model" && capturedArgs[i+1]?.includes("deepseek"))).toBe(true);
  await client.dispose();
});
