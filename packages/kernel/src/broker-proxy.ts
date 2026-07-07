// packages/kernel/src/broker-proxy.ts
import type { AgentName, AskItem } from "@hiagent/shared";
import { IntercomClient } from "pi-intercom/broker/client";
import type { AgentManager } from "./agent-manager";
import type { ProjectStore } from "./project-store";

interface PendingMessage {
  messageId: string;
  fromId: string;
  fromName: string;
  text: string;
  expectsReply?: boolean;
  replyTo?: string;
}

interface ProxyEntry {
  client: IntercomClient;
  projectId: string;
  agentName: AgentName;
}

export interface BrokerProxyOpts {
  projectStore: ProjectStore;
  agentManager: AgentManager;
  onAsk: (ask: AskItem) => void;
  onReply: (askMessageId: string, sessionId: string) => void;
}

export class BrokerProxyManager {
  private proxies: Map<string, ProxyEntry> = new Map();  // key: "{projectId}-{agentName}"
  private pending: Map<string, PendingMessage[]> = new Map();
  private relayClient: IntercomClient | null = null;  // kernel 自身的 broker 连接，用于转发
  private started = false;

  constructor(private opts: BrokerProxyOpts) {}

  /** 为所有 project×agent 注册代理 session */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 先创建 relay client（kernel 自身的 broker 身份，用于消息转发）
    this.relayClient = new IntercomClient();
    await this.relayClient.connect({
      name: "hiagent-relay",
      cwd: process.cwd(),
      model: "kernel",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: "relay",
    });

    // relay 监听回复：真实 agent 回复 relay 后，relay 转发回原始发送方
    this.relayClient.on("message", (from: any, message: any) => {
      if (message.replyTo) {
        this.handleRelayReply(from, message);
      }
    });

    // 为每个 project×agent 注册代理
    const { projects } = await this.opts.projectStore.load();
    for (const project of projects) {
      await this.registerProjectProxies(project.id);
    }
  }

  /** relay 收到回复时，转发给原始发送方 */
  private async handleRelayReply(from: any, message: any): Promise<void> {
    // 查找 replyTo 对应的原始发送方
    for (const [key, queue] of this.pending) {
      const idx = queue.findIndex(m => m.messageId === message.replyTo);
      if (idx >= 0) {
        const originalSenderId = queue[idx].fromId;
        // 转发回复给原始发送方
        try {
          await this.relayClient!.send(originalSenderId, {
            text: message.content.text,
            replyTo: message.replyTo,  // 保留原始 replyTo，让 waitForReply 匹配
          });
        } catch (err) {
          console.warn(`[kernel] 转发回复失败: ${(err as Error).message}`);
        }
        // 已处理的缓存消息可以清理
        queue.splice(idx, 1);
        if (queue.length === 0) this.pending.delete(key);
        return;
      }
    }
  }

  /** 为指定 project 的所有 agent 注册代理 */
  async registerProjectProxies(projectId: string): Promise<void> {
    const { ALL_AGENT_NAMES } = await import("@hiagent/shared");
    for (const agentName of ALL_AGENT_NAMES) {
      await this.registerProxy(projectId, agentName);
    }
  }

  /** 注册单个代理 session */
  async registerProxy(projectId: string, agentName: AgentName): Promise<void> {
    const key = `${projectId}-${agentName}`;
    if (this.proxies.has(key)) return;

    const client = new IntercomClient();
    try {
      await client.connect({
        name: key,  // 公开名: "{projectId}-{agentName}"
        cwd: process.cwd(),
        model: "proxy",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: "proxy",
      });
    } catch (err) {
      console.warn(`[kernel] 代理注册失败 ${key}: ${(err as Error).message}`);
      return;
    }

    const entry: ProxyEntry = { client, projectId, agentName };
    this.proxies.set(key, entry);

    // 监听代理收到的消息
    client.on("message", (from: any, message: any) => {
      this.handleProxyMessage(key, entry, from, message);
    });

    console.log(`[kernel] 代理已注册: ${key} (sessionId=${client.sessionId})`);
  }

  /** 代理收到消息：缓存 + 确保目标在线 + 转发 */
  private async handleProxyMessage(
    key: string,
    entry: ProxyEntry,
    from: any,
    message: any,
  ): Promise<void> {
    const pending: PendingMessage = {
      messageId: message.id,
      fromId: from.id,
      fromName: from.name || from.id.slice(0, 8),
      text: message.content.text,
      expectsReply: message.expectsReply,
      replyTo: message.replyTo,
    };

    // 缓存消息
    const queue = this.pending.get(key) ?? [];
    queue.push(pending);
    this.pending.set(key, queue);

    // 通知前端
    this.opts.onAsk({
      messageId: message.id,
      sessionId: entry.projectId,  // 用 projectId 作为 sessionId 上下文
      from: entry.agentName,       // 这是目标 agent——实际 from 来自发送方
      to: entry.agentName,
      text: message.content.text,
      startedAt: Date.now(),
      resolved: false,
    });

    // 确保目标 agent 在线
    try {
      await this.opts.agentManager.ensureStarted(entry.projectId, entry.agentName);
    } catch (err) {
      console.warn(`[kernel] 启动 agent 失败 ${key}: ${(err as Error).message}`);
      return;
    }

    // 转发所有缓存消息到真实 agent（内部名）
    await this.flushPending(key, entry);
  }

  /** 将缓存消息转发到真实 agent */
  private async flushPending(key: string, entry: ProxyEntry): Promise<void> {
    const queue = this.pending.get(key);
    if (!queue || queue.length === 0) return;

    const realName = `${key}-real`;  // 真实 Pi 进程的 broker 名
    if (!this.relayClient) return;

    for (const msg of queue) {
      try {
        // 用 relay client 转发（保留原始 messageId）
        // 注意：relay 发送时 from 是 relay 的 session info
        // 真实 agent 的 replyTracker 会记录 relay 作为 from
        // 当真实 agent 回复时，reply 会回到 relay
        // relay 收到 reply 后，再转发给原始发送方 (msg.fromId)
        const result = await this.relayClient.send(realName, {
          messageId: msg.messageId,
          text: msg.text,
          expectsReply: msg.expectsReply,
          replyTo: msg.replyTo,
        });
        if (!result.delivered) {
          console.warn(`[kernel] 转发消息失败 ${key}: ${result.reason}`);
        }
      } catch (err) {
        console.warn(`[kernel] 转发消息异常 ${key}: ${(err as Error).message}`);
      }
    }

    this.pending.delete(key);
  }

  /** agent 进程退出时，重新注册代理 */
  async onAgentOffline(projectId: string, agentName: AgentName): Promise<void> {
    const key = `${projectId}-${agentName}`;
    // 确保代理重新注册（如果之前因冲突被断开）
    if (!this.proxies.has(key) || !this.proxies.get(key)!.client.isConnected()) {
      // 清理旧代理
      const old = this.proxies.get(key);
      if (old) {
        try { await old.client.disconnect(); } catch {}
        this.proxies.delete(key);
      }
      await this.registerProxy(projectId, agentName);
      console.log(`[kernel] 代理重新注册: ${key}`);
    }
  }

  async dispose(): Promise<void> {
    this.started = false;
    for (const entry of this.proxies.values()) {
      try { await entry.client.disconnect(); } catch {}
    }
    this.proxies.clear();
    this.pending.clear();
    if (this.relayClient) {
      try { await this.relayClient.disconnect(); } catch {}
      this.relayClient = null;
    }
  }
}
