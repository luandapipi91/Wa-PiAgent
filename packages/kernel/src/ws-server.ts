import type {
  WSClientEvent, WSServerEvent, AgentName,
} from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { SessionStore } from "./session-store";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { StateAggregator } from "./state-aggregator";

export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  sessionStore: SessionStore;
  agentManager: AgentManager;
  intercomMonitor: IntercomMonitor;
  stateAggregator: StateAggregator;
  port?: number;
}

export class WSServer {
  actualPort = 0;
  private server: any;
  private clients = new Set<any>();  // 跟踪连接的客户端用于广播

  constructor(private opts: WSServerOpts) {}

  // 广播给所有客户端（StateAggregator 的 onServerEvent 调用）
  private broadcast(e: WSServerEvent): void {
    const payload = JSON.stringify(e);
    for (const ws of this.clients) {
      try { ws.send(payload); } catch {}
    }
  }

  // 暴露给 index.ts：把 StateAggregator 的输出接到 broadcast
  bindAggregatorBroadcast(): void {
    (this.opts.stateAggregator as any).opts.onServerEvent = (e: WSServerEvent) => this.broadcast(e);
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.opts.port ?? WS_PORT,
      fetch: (req, server) => {
        if (server.upgrade(req)) return;
        return new Response("WS only", { status: 426 });
      },
      websocket: {
        open: (ws) => { this.clients.add(ws); },
        message: async (ws, msg) => {
          const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as unknown as ArrayBuffer);
          let event: WSClientEvent;
          try { event = JSON.parse(text); } catch { return; }
          // 多数响应通过 broadcast 推全量；少数（projects:list、agent:config）定向回请求者
          const reply = (e: WSServerEvent) => ws.send(JSON.stringify(e));
          await this.handle(event, reply);
        },
        close: (ws) => { this.clients.delete(ws); },
      },
    });
    this.actualPort = this.server.port;
    this.bindAggregatorBroadcast();
  }

  async stop(): Promise<void> {
    this.server?.stop();
    await this.opts.agentManager.disposeAll();
    this.opts.intercomMonitor.dispose();
  }

  private async handle(event: WSClientEvent, reply: (e: WSServerEvent) => void): Promise<void> {
    switch (event.type) {
      case "projects:list": {
        const { projects, sessions } = await this.opts.projectStore.load();
        reply({ type: "projects:list", projects, sessions });  // 定向回请求者
        break;
      }
      case "project:create": {
        const project = await this.opts.projectStore.createProject({ name: event.name, cwd: event.cwd });
        this.broadcast({ type: "project:created", project });  // 广播：所有客户端同步
        break;
      }
      case "project:update": {
        await this.opts.projectStore.updateProject(event.projectId, { name: event.name, cwd: event.cwd });
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "project:delete": {
        await this.opts.projectStore.deleteProject(event.projectId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:rename": {
        await this.opts.projectStore.renameSession(event.sessionId, event.title);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:delete": {
        await this.opts.projectStore.deleteSession(event.sessionId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:messages": {
        // 历史消息从 Pi session 拉（不再读拍扁文件）—— 设计文档核心目标
        const { sessions } = await this.opts.projectStore.load();
        const session = sessions.find(s => s.id === event.sessionId);
        if (!session) {
          reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
          break;
        }
        try {
          const client = await this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent);
          const agentMessages = await client.getMessages();
          const messages = agentMessages.map(m => ({ message: m, agentName: session.primaryAgent }));
          reply({ type: "session:messages", sessionId: event.sessionId, messages });
        } catch (err) {
          reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
        }
        break;
      }
      case "agent:prompt": {
        // session 元数据：前端传的 sessionId 仅作请求追踪，实际 session.id 由 ProjectStore 创建
        const { sessions } = await this.opts.projectStore.load();
        const existing = sessions.find(s => s.id === event.sessionId);
        const session = existing ?? await this.opts.projectStore.createSession({
          projectId: event.projectId, primaryAgent: event.agentName,
          title: event.text.slice(0, 20),
        });
        this.broadcast({ type: "session:created", session });
        await this.opts.projectStore.touchSession(session.id);
        // 广播用户消息（让前端立即显示用户输入）—— 包装成 SessionMessage
        const userMsg = {
          message: { role: "user" as const, content: event.text, timestamp: Date.now() },
          agentName: event.agentName,
          sessionId: session.id,
        };
        this.broadcast({
          type: "agent:message", projectId: event.projectId,
          sessionId: session.id, agentName: event.agentName, message: userMsg,
        });
        // 启动/提示失败不抛——转成 error 事件，避免 WS 消息处理崩溃
        try {
          const client = await this.opts.agentManager.ensureStarted(event.projectId, event.agentName);
          await client.prompt(event.text, session.id);
        } catch (err) {
          this.broadcast({ type: "error", message: `agent 启动失败: ${(err as Error).message}` });
        }
        break;
      }
      case "agent:abort": {
        await this.opts.agentManager.abort(event.projectId, event.agentName);
        break;
      }
      case "intercom:inject-reply": {
        await this.opts.intercomMonitor.injectReply(event.askMessageId, event.text);
        break;
      }
      case "agent:config:get": {
        const config = await this.opts.configStore.getAgent(event.agentName);
        if (config) reply({ type: "agent:config", agentName: event.agentName, config });  // 定向
        break;
      }
      case "agent:config:save": {
        const errs = await this.opts.configStore.saveAgent(event.config);
        if (errs.length) reply({ type: "error", message: errs.join("; ") });
        break;
      }
    }
  }
}
