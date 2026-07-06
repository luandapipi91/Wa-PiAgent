import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PiRpcClient } from "../src/pi-rpc-client";
import type { PiEvent } from "../src/pi-rpc-client";
import type { AgentName } from "@hiagent/shared";

// mock 子进程：模拟 pi --mode rpc 的 stdin/stdout JSONL
function mockSpawn() {
  let stdoutBuf = "";
  const stdout = new EventEmitter();
  const child = {
    stdin: { write: (s: string) => { stdoutBuf += s; }, end: () => {} },
    stdout,  // EventEmitter 自带 on/emit，PiRpcClient 用 stdout.on("data", cb)
    stderr: new EventEmitter(),
    killed: false,
    kill: () => { child.killed = true; },
    // 测试辅助：向 client 推一行 JSON
    emitLine: (obj: unknown) => stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n")),
    // 测试辅助：读/重置 stdin 写入缓冲
    getStdoutBuf: () => stdoutBuf,
    resetStdoutBuf: () => { stdoutBuf = ""; },
  };
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

test("onEvent 收 message_update → message 事件", async () => {
  const mock = mockSpawn();
  const events: PiEvent[] = [];
  const client = new PiRpcClient({
    agentName: "dev", cwd: "/work",
    onEvent: e => events.push(e),
    spawnFn: () => mock as any,
  });
  await client.start();
  mock.emitLine({ type: "message_update", role: "assistant", text: "回复" });
  expect(events.find(e => e.kind === "message")).toBeDefined();
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
