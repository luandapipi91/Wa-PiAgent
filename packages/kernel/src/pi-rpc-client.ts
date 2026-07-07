import type { AgentName, ChatMessage, AgentState, AskItem } from "@hiagent/shared";
import { randomUUID } from "node:crypto";

export type PiEvent =
  | { kind: "message"; message: ChatMessage }
  | { kind: "state"; state: AgentState }
  | { kind: "intercom:ask"; ask: AskItem }
  | { kind: "intercom:reply"; askMessageId: string }
  | { kind: "error"; message: string };

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
  // 当前 prompt 的会话 id，用于给 message 事件补 sessionId（一个 client 服务多会话）
  private currentSessionId = "";

  constructor(private opts: PiRpcClientOpts) {
    this.sessionName = opts.sessionId ?? opts.agentName;
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    // 注意：pi 不认 --cwd 参数，工作目录通过 spawn 的 cwd 选项传入
    this.child = spawnFn("pi", [
      "--mode", "rpc",
      "--name", this.sessionName,
    ], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[kernel] spawn pi: name=${this.sessionName} cwd=${this.opts.cwd}`);
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[kernel] pi stderr: ${chunk.toString().trim()}`);
    });
    // 握手
    await this.send({ type: "get_state" });
  }

  async prompt(text: string, sessionId?: string): Promise<void> {
    if (sessionId) this.currentSessionId = sessionId;
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
      // pi 0.80 RPC 协议：request/response（get_state / prompt / abort 等）
      case "response": {
        // 失败响应：透传 error 给前端
        if (obj.success === false) {
          this.opts.onEvent({
            kind: "error",
            message: obj.error ?? `${obj.command ?? "rpc"} 失败`,
          });
          // 失败后 agent 回到 idle
          this.opts.onEvent({
            kind: "state",
            state: { name: this.opts.agentName, status: "idle" },
          });
          break;
        }
        // 成功响应：按 command 分发
        if (obj.command === "prompt" && obj.success !== false) {
          const d = obj.data ?? {};
          const text = d.text ?? d.message
            ?? (Array.isArray(d.messages) ? d.messages.map((m: any) => m.content ?? m.text).join("\n") : null)
            ?? (typeof d === "string" ? d : null);
          if (text) {
            this.opts.onEvent({
              kind: "message",
              message: {
                id: randomUUID(),
                sessionId: this.currentSessionId,
                role: "assistant",
                text,
                timestamp: Date.now(),
              },
            });
          }
          // prompt 完成后 agent 回到 idle
          this.opts.onEvent({
            kind: "state",
            state: { name: this.opts.agentName, status: "idle" },
          });
        }
        break;
      }
      case "message_update":
        // 流式增量（pi 可能在 prompt 处理中推送）
        this.opts.onEvent({
          kind: "message",
          message: {
            id: randomUUID(),
            sessionId: this.currentSessionId,
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
// 把 Bun 的 Web Streams（ReadableStream）适配成 Node EventEmitter 风格（.on("data", cb)）
// 供 PiRpcClient.start 的 stdout.on("data") 调用
function defaultSpawn(cmd: string, args: string[], opts: SpawnOptions["opts"]): MockChild {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,  // 继承环境（含 PATH，让 pi 命令可被找到）
  });
  // 监听 pi 进程退出（诊断用：pi 启动失败会立即退出）
  proc.exited.then((code: number | null) => {
    console.log(`[kernel] pi 进程退出 code=${code} pid=${proc.pid}`);
  }).catch(() => {});
  return {
    stdin: {
      write: (s: string) => proc.stdin?.write(s),
      end: () => proc.stdin?.end(),
    },
    stdout: toNodeStream(proc.stdout),
    stderr: toNodeStream(proc.stderr),
    get killed() { return proc.killed },
    kill: () => { if (!proc.killed) proc.kill(); },
  };
}

// Bun ReadableStream → { on(event, cb) } Node 风格适配器
// 异步循环读取 chunk，通过 "data" 事件回调分发
function toNodeStream(stream: ReadableStream<Uint8Array> | null): MockChild["stdout"] {
  const handlers: Record<string, ((chunk: Buffer) => void)[]> = {};
  if (stream) {
    (async () => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const buf = Buffer.from(value);
            for (const cb of (handlers["data"] ?? [])) cb(buf);
          }
        }
      } catch { /* 流关闭或出错，忽略 */ }
    })();
  }
  return {
    on: (event: string, cb: (chunk: Buffer) => void) => {
      (handlers[event] ??= []).push(cb);
    },
  };
}
