### Task 9: IntercomMonitor（连 broker，跟踪 ask）

**Files:**
- Create: `packages/kernel/src/intercom-monitor.ts`
- Test: `packages/kernel/tests/intercom-monitor.test.ts`

**Interfaces:**
- Consumes: `AskItem`, `AgentName` from `@hiagent/shared`
- Produces:
  - `class IntercomMonitor { constructor(opts: { onAsk: (ask: AskItem) => void; onReply: (askMessageId: string, sessionId: string) => void; connectFn?: () => Promise<Socket>; }); connect(): Promise<void>; injectReply(askMessageId: string, text: string): Promise<void>; getQueues(): Map<AgentName, AskItem[]>; dispose(): void; }`
  - `connectFn` 可注入，测试用 mock socket；生产连 broker（pi-intercom 的 `getBrokerSocketPath`）

- [ ] **Step 1: 写失败测试（mock socket）**

`packages/kernel/tests/intercom-monitor.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { IntercomMonitor } from "../src/intercom-monitor";
import type { AskItem } from "@hiagent/shared";

function mockSocket() {
  const ee = new EventEmitter();
  const sock = Object.assign(ee, {
    writeBuf: "",
    write: (s: string) => { sock.writeBuf += s; },
    end: () => {},
    destroyed: false,
    // 测试辅助
    emitMsg: (obj: unknown) => sock.emit("data", Buffer.from(JSON.stringify(obj) + "\n")),
  });
  return sock;
}

test("connect 后收 ask → onAsk", async () => {
  const sock = mockSocket() as any;
  const asks: AskItem[] = [];
  const mon = new IntercomMonitor({
    onAsk: a => asks.push(a),
    onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: 0 });
  expect(asks).toHaveLength(1);
  expect(asks[0].to).toBe("dev");
  mon.dispose();
});

test("injectReply 写入 socket", async () => {
  const sock = mockSocket() as any;
  const mon = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.writeBuf = "";
  await mon.injectReply("a1", "用户替答");
  expect(sock.writeBuf).toContain("a1");
  expect(sock.writeBuf).toContain("用户替答");
  mon.dispose();
});

test("getQueues 按 to 维度聚合", async () => {
  const sock = mockSocket() as any;
  const mon = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1", startedAt: 0 });
  sock.emitMsg({ kind: "ask", messageId: "a2", sessionId: "s1", from: "pm", to: "dev", text: "2", startedAt: 0 });
  const q = mon.getQueues();
  expect(q.get("dev")).toHaveLength(2);
  mon.dispose();
});

test("收 reply 后从队列移除", async () => {
  const sock = mockSocket() as any;
  const replies: [string, string][] = [];
  const mon = new IntercomMonitor({
    onAsk: () => {},
    onReply: (id, sid) => replies.push([id, sid]),
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1", startedAt: 0 });
  sock.emitMsg({ kind: "reply", askMessageId: "a1", sessionId: "s1" });
  expect(replies).toEqual([["a1", "s1"]]);
  expect(mon.getQueues().get("dev")).toHaveLength(0);
  mon.dispose();
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 intercom-monitor.ts**

`packages/kernel/src/intercom-monitor.ts`:
```typescript
import type { Socket } from "node:net";
import type { AgentName, AskItem } from "@hiagent/shared";

export interface IntercomMonitorOpts {
  onAsk: (ask: AskItem) => void;
  onReply: (askMessageId: string, sessionId: string) => void;
  connectFn?: () => Promise<Socket & { writeBuf?: string }>;
}

export class IntercomMonitor {
  private socket: (Socket & { writeBuf?: string }) | null = null;
  private buf = "";
  // 按 to（被问 agent）维度聚合的 FIFO 队列
  private queues = new Map<AgentName, AskItem[]>();
  private allAsks = new Map<string, AskItem>();  // askMessageId → ask

  constructor(private opts: IntercomMonitorOpts) {}

  async connect(): Promise<void> {
    const sock = this.opts.connectFn
      ? await this.opts.connectFn()
      : await this.connectReal();
    this.socket = sock;
    sock.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
  }

  private handleLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.kind === "ask" || obj.type === "ask") {
      const ask: AskItem = {
        messageId: obj.messageId,
        sessionId: obj.sessionId,
        from: obj.from,
        to: obj.to,
        text: obj.text,
        startedAt: obj.startedAt ?? Date.now(),
        resolved: false,
      };
      this.allAsks.set(ask.messageId, ask);
      const q = this.queues.get(ask.to) ?? [];
      q.push(ask);
      this.queues.set(ask.to, q);
      this.opts.onAsk(ask);
    } else if (obj.kind === "reply" || obj.type === "reply") {
      const askMessageId = obj.askMessageId;
      const sessionId = obj.sessionId;
      const ask = this.allAsks.get(askMessageId);
      if (ask) {
        const q = this.queues.get(ask.to);
        if (q) this.queues.set(ask.to, q.filter(a => a.messageId !== askMessageId));
        this.allAsks.delete(askMessageId);
      }
      this.opts.onReply(askMessageId, sessionId);
    }
  }

  getQueues(): Map<AgentName, AskItem[]> {
    return new Map(this.queues);
  }

  async injectReply(askMessageId: string, text: string): Promise<void> {
    if (!this.socket) throw new Error("IntercomMonitor 未连接");
    this.socket.write(JSON.stringify({
      kind: "inject-reply",
      askMessageId,
      text,
    }) + "\n");
  }

  dispose(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  // 生产连接：broker socket 路径由 pi-intercom 决定（win32 Named Pipe / Unix socket）
  private async connectReal(): Promise<Socket> {
    const { connect } = await import("node:net");
    // 通过动态 import pi-intercom 拿 socket 路径，避免硬编码平台分支
    let socketPath: string;
    try {
      const mod = await import("pi-intercom/broker/paths");
      socketPath = (mod as any).getBrokerSocketPath();
    } catch {
      // 回退：等 broker 起来后用默认路径
      const home = process.env.HOME || process.env.USERPROFILE || ".";
      socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\pi-intercom-${(home as string).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`
        : `${home}/.pi/agent/intercom/broker.sock`;
    }
    return new Promise((resolve, reject) => {
      const sock = connect(socketPath, () => resolve(sock));
      sock.on("error", reject);
    });
  }
}
```

> 注：broker 消息协议（`kind: "ask"/"reply"`）以 Task 1 验证文档为准；若 pi-intercom broker 用不同字段，调整 `handleLine`。inject-reply 的实际发送格式需对照 pi-intercom client API。

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/intercom-monitor.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/intercom-monitor.ts packages/kernel/tests/intercom-monitor.test.ts
git commit -m "feat(kernel): IntercomMonitor（连 broker，跟踪 ask 队列 + injectReply）"
```

---

