import { EventEmitter } from "node:events";
import { IntercomClient } from "pi-intercom/broker/client";

export class IntercomMonitor extends EventEmitter {
  private client: IntercomClient | null = null;

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new IntercomClient();
    this.client.on("message", (from: any, message: any) => {
      const text = message.content?.text ?? "";
      const fromName = from?.name ?? from?.id;
      if (message.replyTo) {
        this.emit("reply", { toAskMessageId: message.replyTo, text, from: fromName });
      } else {
        this.emit("message", { from: fromName, message });
      }
    });
    await this.client.connect({
      name: "hiagent-monitor", cwd: process.cwd(), model: "monitor",
      pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status: "monitor",
    });
  }

  async disconnect(): Promise<void> { await this.client?.disconnect(); this.client = null; }
  async listSessions(): Promise<any[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.listSessions();
  }

  /** 用户替答（spec 4.3 🙋 我来回答）：合成 reply 给原 ask 发起方 */
  async injectReply(askMessageId: string, _fromAgent: string, toAskFrom: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    const sessions = await this.client.listSessions();
    const target = sessions.find((s: any) => s.name === toAskFrom);
    if (!target) throw new Error(`Agent ${toAskFrom} not on broker`);
    await this.client.send(target.id, { text, replyTo: askMessageId });
  }
}
