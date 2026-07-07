import type { AgentName, ChatMessage, AgentState, AskItem, AgentConfig } from "@hiagent/shared";
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
  config?: AgentConfig;  // agent 配置（系统提示词/工具/模型）
}

export class PiRpcClient {
  private child: MockChild | null = null;
  private stdoutBuf = "";
  private pendingId = 0;
  private readonly sessionName: string;
  // 当前 prompt 的会话 id，用于给 message 事件补 sessionId（一个 client 服务多会话）
  private currentSessionId = "";
  // 流式回复累积：message_start 时建 id，message_update 累积 text，message_end 发最终
  private streamingMsgId = "";
  private streamingText = "";

  constructor(private opts: PiRpcClientOpts) {
    this.sessionName = opts.sessionId ?? opts.agentName;
  }

  async start(): Promise<void> {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    // broker 公开名由代理占据，真实进程用内部名
    const brokerName = `${this.sessionName}-real`;
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
      // pi 0.80 RPC：request/response（get_state/prompt 的确认或失败）
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
        }
        // prompt 成功确认（success:true）不做事，等流式事件
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
      // assistant 消息开始：初始化流式累积器
      case "message_start": {
        const msg = obj.message;
        if (msg?.role === "assistant") {
          this.streamingMsgId = randomUUID();
          this.streamingText = "";
          // 发空消息占位（前端立即显示 agent 正在回复）
          this.opts.onEvent({
            kind: "message",
            message: {
              id: this.streamingMsgId,
              sessionId: this.currentSessionId,
              role: "assistant",
              text: "",
              timestamp: Date.now(),
            },
          });
        }
        break;
      }
      // 流式增量：累积 text，更新同 id 消息
      case "message_update": {
        const evt = obj.assistantMessageEvent;
        // 只处理正文增量（text_delta / text），跳过 thinking_delta
        if (evt && (evt.type === "text_delta" || evt.type === "text")) {
          this.streamingText += evt.delta ?? "";
          if (this.streamingMsgId) {
            this.opts.onEvent({
              kind: "message",
              message: {
                id: this.streamingMsgId,
                sessionId: this.currentSessionId,
                role: "assistant",
                text: this.streamingText,
                timestamp: Date.now(),
              },
            });
          }
        }
        break;
      }
      // 消息完成：发最终完整 text（覆盖流式占位）
      case "message_end": {
        const msg = obj.message;
        if (msg?.role === "assistant") {
          const content: any[] = Array.isArray(msg.content) ? msg.content : [];
          const text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("");
          // 用流式期间的同一个 id，前端 upsert 更新最终文本
          const id = this.streamingMsgId || randomUUID();
          this.opts.onEvent({
            kind: "message",
            message: {
              id,
              sessionId: this.currentSessionId,
              role: "assistant",
              text: text || this.streamingText,
              timestamp: Date.now(),
            },
          });
          this.streamingMsgId = "";
          this.streamingText = "";
        }
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
