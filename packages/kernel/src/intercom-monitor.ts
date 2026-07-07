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
    // broker 不可用时 connectReal 返回 null：跳过监听，intercom 降级
    if (!sock) return;
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
    // 防御式：mock socket 可能只提供 end()/destroyed 而无 destroy()，
    // 生产 net.Socket 两者皆有。优先 destroy，回退 end。
    const sock = this.socket as (Socket & { writeBuf?: string }) | null;
    if (sock) {
      if (typeof sock.destroy === "function") sock.destroy();
      else if (typeof sock.end === "function") sock.end();
    }
    this.socket = null;
  }

  // 生产连接：broker socket 路径由 pi-intercom 决定（win32 Named Pipe / Unix socket）
  // broker 可能未启动（如 E2E 无 pi 环境）→ resolve(null) 降级，不阻塞 kernel 主流程
  private async connectReal(): Promise<Socket | null> {
    const { connect } = await import("node:net");
    let socketPath: string;
    try {
      const mod = await import("pi-intercom/broker/paths");
      socketPath = (mod as any).getBrokerSocketPath();
    } catch {
      const home = process.env.HOME || process.env.USERPROFILE || ".";
      socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\pi-intercom-${(home as string).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`
        : `${home}/.pi/agent/intercom/broker.sock`;
    }
    return new Promise((resolve) => {
      const sock = connect(socketPath, () => resolve(sock));
      // broker 不可用：降级为 null，kernel 继续起 WS server（intercom 功能失效但不崩）
      sock.on("error", () => {
        console.warn(`[kernel] intercom broker 未就绪（${socketPath}），intercom 功能降级`);
        resolve(null);
      });
    });
  }
}
