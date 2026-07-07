import type { AgentName, AgentMessage, AgentState, AgentConfig } from "@hiagent/shared";
import type { SessionMessage } from "@hiagent/shared";
import { HIAGENT_PI_AGENT_DIR } from "@hiagent/shared";

export type PiEvent =
  | { kind: "message"; message: SessionMessage }
  | { kind: "state"; state: AgentState }
  | { kind: "error"; message: string };
// 注：intercom:ask / intercom:reply 废弃（broker-proxy 删了）

interface SpawnOptions {
  cmd: string;
  args: string[];
  opts: { cwd: string; stdio: [string, string, string]; env: Record<string, string | undefined> };
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
  config?: AgentConfig;  // agent 配置（系统提示词/工具/模型）
  env?: Record<string, string | undefined>;
}

export class PiRpcClient {
  private child: MockChild | null = null;
  private stdoutBuf = "";
  private pendingId = 0;
  private pendingRpcResolvers = new Map<number, (data: unknown) => void>();
  private readonly sessionName: string;
  // 当前 prompt 的会话 id，用于给 message 事件补 sessionId（一个 client 服务多会话）
  private currentSessionId = "";
  // 流式回复累积 content 数组（透传 Pi 富消息）
  private streamingContent: any[] = [];

  constructor(private opts: PiRpcClientOpts) {
    this.sessionName = opts.sessionId ?? opts.agentName;
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    // 去 -real 后缀：删 broker-proxy 后不再有占位代理，真实进程直接用 sessionName
    const brokerName = this.sessionName;
    const args = ["--mode", "rpc", "--name", brokerName];
    const c = this.opts.config;
    if (c) {
      if (c.model) args.push("--model", c.model);
      if (c.tools.length) args.push("--tools", c.tools.join(","));
      // 系统提示词：replace 模式用 body 覆盖；append 模式追加
      if (c.systemPromptBody) {
        args.push(c.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", c.systemPromptBody);
      }
    }
    this.child = spawnFn("pi", args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: HIAGENT_PI_AGENT_DIR, ...this.opts.env },
    });
    console.log(`[kernel] spawn pi: name=${brokerName} cwd=${this.opts.cwd} model=${c?.model ?? "default"}`);
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

  async getMessages(): Promise<AgentMessage[]> {
    const id = ++this.pendingId;
    return new Promise((resolve) => {
      this.pendingRpcResolvers.set(id, (data: any) => resolve(data?.messages ?? []));
      this.send({ type: "get_messages" }, id);
    });
  }

  async dispose(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }

  private async send(obj: unknown, preoccupiedId?: number): Promise<void> {
    if (!this.child) throw new Error("PiRpcClient 未启动");
    const payload = typeof obj === "object" && obj !== null
      ? { ...(obj as object), id: preoccupiedId ?? ++this.pendingId }
      : obj;
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string): void {
    let obj: any;
    try { obj = JSON.parse(line); } catch { return; }
    switch (obj.type) {
      // pi 0.80 RPC：request/response（get_state/prompt 的确认或失败 / get_messages 的数据）
      case "response": {
        if (obj.success === false) {
          this.opts.onEvent({
            kind: "error",
            message: obj.error ?? `${obj.command ?? "rpc"} 失败`,
          });
          this.opts.onEvent({
            kind: "state",
            state: { name: this.opts.agentName, status: "idle" },
          });
        } else if (obj.success === true && obj.id != null) {
          const resolver = this.pendingRpcResolvers.get(obj.id);
          if (resolver) {
            this.pendingRpcResolvers.delete(obj.id);
            resolver(obj.data);
          }
        }
        break;
      }
      // 流式生命周期：agent 开始工作 → thinking
      case "agent_start":
      case "turn_start":
        this.opts.onEvent({
          kind: "state",
          state: { name: this.opts.agentName, status: "thinking" },
        });
        break;
      // assistant 消息开始：重置流式 content 累积器
      case "message_start": {
        const msg = obj.message;
        if (msg?.role === "assistant") {
          this.streamingContent = [];
          this.opts.onEvent({
            kind: "message",
            message: {
              message: { ...msg, content: [] },
              agentName: this.opts.agentName,
              sessionId: this.currentSessionId,
            },
          });
        }
        break;
      }
      // 流式增量：累积 content 数组，透传最新 partial
      case "message_update": {
        const evt = obj.assistantMessageEvent;
        if (evt?.partial?.content) {
          this.streamingContent = evt.partial.content as any[];
          this.opts.onEvent({
            kind: "message",
            message: {
              message: { ...evt.partial, content: this.streamingContent },
              agentName: this.opts.agentName,
              sessionId: this.currentSessionId,
            },
          });
        }
        break;
      }
      // 消息完成：透传完整 message（不再 filter 成 text）
      case "message_end": {
        const msg = obj.message;
        if (msg?.role === "assistant") {
          this.opts.onEvent({
            kind: "message",
            message: {
              message: msg as AgentMessage,
              agentName: this.opts.agentName,
              sessionId: this.currentSessionId,
            },
          });
        }
        this.streamingContent = [];
        break;
      }
      // 回合/agent 结束 → idle
      case "turn_end":
      case "agent_end":
        this.opts.onEvent({
          kind: "state",
          state: { name: this.opts.agentName, status: "idle" },
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
    env: opts.env ?? process.env,  // 继承环境（含 PATH + PI_CODING_AGENT_DIR），让 pi 命令可被找到
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
