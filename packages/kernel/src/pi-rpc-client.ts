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
