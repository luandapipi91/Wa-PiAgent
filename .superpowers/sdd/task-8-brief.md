### Task 8: PiRpcClient（spawn + JSONL）

**Files:**
- Create: `packages/kernel/src/pi-rpc-client.ts`
- Test: `packages/kernel/tests/pi-rpc-client.test.ts`

**Interfaces:**
- Consumes: `AgentName` from `@hiagent/shared`
- Produces:
  - `interface PiRpcHandlers { onMessage?: (msg: ChatMessage) => void; onState?: (state: AgentState) => void; onIntercomAsk?: (ask: AskItem) => void; onIntercomReply?: (askMessageId: string) => void; }`
  - `class PiRpcClient { constructor(opts: { agentName: AgentName; cwd: string; onEvent: (e: PiEvent) => void; spawnFn?: (cmd, args, opts) => Child; }); start(): Promise<void>; prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): Promise<void>; }`
  - `type PiEvent = { kind: "message"; message: ChatMessage } | { kind: "state"; state: AgentState } | { kind: "intercom:ask"; ask: AskItem } | { kind: "intercom:reply"; askMessageId: string }`
  - **关键**：`spawnFn` 可注入，测试用 mock 子进程；生产传 `Bun.spawn`

- [ ] **Step 1: 写失败测试（mock spawn）**

`packages/kernel/tests/pi-rpc-client.test.ts`:
```typescript
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
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 pi-rpc-client.ts**

`packages/kernel/src/pi-rpc-client.ts`:
```typescript
import type { AgentName, ChatMessage, AgentState, AskItem } from "@hiagent/shared";
import { randomUUID } from "node:crypto";

export type PiEvent =
  | { kind: "message"; message: ChatMessage }
  | { kind: "state"; state: AgentState }
  | { kind: "intercom:ask"; ask: AskItem }
  | { kind: "intercom:reply"; askMessageId: string };

interface SpawnOptions {
  cmd: string;
  args: string[];
  opts: { cwd: string; stdio: [string, string, string] };
}

interface MockChild {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  stderr: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  killed: boolean;
  kill: () => void;
}

export interface PiRpcClientOpts {
  agentName: AgentName;
  cwd: string;
  onEvent: (e: PiEvent) => void;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions["opts"]) => MockChild;
  sessionId?: string;  // pi-intercom 会话名，默认用 agentName
}

export class PiRpcClient {
  private child: MockChild | null = null;
  private stdoutBuf = "";
  private pendingId = 0;
  private readonly sessionName: string;

  constructor(private opts: PiRpcClientOpts) {
    this.sessionName = opts.sessionId ?? opts.agentName;
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    this.child = spawnFn("pi", [
      "--mode", "rpc",
      "--name", this.sessionName,
      "--cwd", this.opts.cwd,
    ], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    this.child.stderr.on("data", () => { /* 日志，忽略 */ });
    // 握手
    await this.send({ type: "get_state" });
  }

  async prompt(text: string): Promise<void> {
    await this.send({ type: "prompt", message: text });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  async dispose(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }

  private async send(obj: unknown): Promise<void> {
    if (!this.child) throw new Error("PiRpcClient 未启动");
    const payload = typeof obj === "object" && obj !== null
      ? { ...(obj as object), id: ++this.pendingId }
      : obj;
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    switch (obj.type) {
      case "message_update":
        this.opts.onEvent({
          kind: "message",
          message: {
            id: randomUUID(),
            sessionId: "",  // 由 AgentManager 填
            role: obj.role === "user" ? "user" : "assistant",
            text: obj.text ?? "",
            timestamp: Date.now(),
          },
        });
        break;
      case "state_change":
        this.opts.onEvent({
          kind: "state",
          state: {
            name: this.opts.agentName,
            status: obj.state?.status === "thinking" ? "thinking"
              : obj.state?.status === "blocked" ? "blocked" : "idle",
            tokenCount: obj.state?.tokenCount,
            model: obj.state?.model,
          },
        });
        break;
      // intercom ask/reply 由 IntercomMonitor 从 broker 旁路监听，
      // 这里不处理；PiRpcClient 只管 pi 主线 RPC
    }
  }
}

// 生产 spawn：Bun.spawn
function defaultSpawn(cmd: string, args: string[], opts: SpawnOptions["opts"]): MockChild {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdin: {
      write: (s: string) => proc.stdin?.write(s),
      end: () => proc.stdin?.end(),
    },
    stdout: proc.stdout as unknown as MockChild["stdout"],
    stderr: proc.stderr as unknown as MockChild["stderr"],
    killed: false,
    kill: () => { proc.kill(); },
  };
}
```

> 注：pi `--mode rpc` 的实际事件字段名（`message_update`/`state_change` 等）以 Task 1 验证文档为准；若不同，调整 `handleLine` 的 switch。`--name` 参数让 pi-intercom 用该名注册，多 agent 互引用此名。

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/pi-rpc-client.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/pi-rpc-client.ts packages/kernel/tests/pi-rpc-client.test.ts
git commit -m "feat(kernel): PiRpcClient（真实 spawn + JSONL，测试 mock 子进程）"
```

> 验证（四层）：第一层 4 passed（mock spawn）。第三层 `[需 pi 环境]`：手动起真实 pi，发 prompt 收流式回复——本 Task 不强制，Task 33 集成测试覆盖。

---

