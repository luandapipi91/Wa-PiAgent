import type {
  WSClientEvent, WSServerEvent, AgentName,
} from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";
import type { DirEntry } from "@hiagent/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { AgentManager } from "./agent-manager";
import type { ProviderStore } from "./provider-store";
import { testProviderConnection } from "./provider-test";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { makeDefaultAgentConfig } from "./agent-md";

export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  agentManager: AgentManager;
  providerStore: ProviderStore;
  dataDir?: string;
  port?: number;
}

export class WSServer {
  actualPort = 0;
  private server: any;
  private clients = new Set<any>();  // 跟踪连接的客户端用于广播

  constructor(private opts: WSServerOpts) {}

  // 广播给所有客户端（AgentManager.onEvent 在 index.ts 里直接调此方法）
  broadcast(e: WSServerEvent): void {
    const payload = JSON.stringify(e);
    for (const ws of this.clients) {
      try { ws.send(payload); } catch {}
    }
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
  }

  async stop(): Promise<void> {
    this.server?.stop();
    await this.opts.agentManager.disposeAll();
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
      case "project:open-dir": {
        const data = await this.opts.projectStore.load();
        const project = data.projects.find(p => p.id === event.projectId);
        if (project?.cwd && existsSync(project.cwd)) {
          const openCmd = process.platform === "darwin" ? "open"
            : process.platform === "win32" ? "start" : "xdg-open";
          spawn(openCmd, [project.cwd], { shell: true, stdio: "ignore" });
        }
        break;
      }
      case "session:rename": {
        await this.opts.projectStore.renameSession(event.sessionId, event.title);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:delete": {
        // 先清理 SDK session（解绑事件订阅 + dispose），再删 ProjectStore 里的会话记录
        await this.opts.agentManager.disposeSession(event.sessionId);
        await this.opts.projectStore.deleteSession(event.sessionId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:messages": {
        // 历史消息从 ensureStarted 返回的 AgentSession.messages 同步读（不再读拍扁文件，也不再 await getMessages）
        const { sessions } = await this.opts.projectStore.load();
        const session = sessions.find(s => s.id === event.sessionId);
        if (!session) {
          reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
          break;
        }
        try {
          const sdkSession = await this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent, session.id);
          // SDK AgentMessage 与 shared AgentMessage 结构兼容但 TS 判为不同类型，用 any 桥接
          const messages = (sdkSession.messages as any[]).map(m => ({ message: m, agentName: session.primaryAgent }));
          reply({ type: "session:messages", sessionId: event.sessionId, messages });
        } catch {
          reply({ type: "session:messages", sessionId: event.sessionId, messages: [] });
        }
        break;
      }
      case "agent:prompt": {
        // 用前端传的 sessionId 查找已有 session；找不到则用该 id 创建，确保前后端一致
        const { sessions } = await this.opts.projectStore.load();
        const existing = sessions.find(s => s.id === event.sessionId);
        const isNew = !existing;
        const session = existing ?? await this.opts.projectStore.createSession({
          projectId: event.projectId, primaryAgent: event.agentName,
          title: event.text.slice(0, 20),
          id: event.sessionId,
        });
        if (isNew) this.broadcast({ type: "session:created", session });
        await this.opts.projectStore.touchSession(session.id);
        // 用户消息不再手动广播——SDK session.prompt() 内部会产生 message_start(user) 事件，
        // 通过 AgentManager.subscribe → sdk:event 自动透传给前端
        // 启动/提示失败不抛——转成 error 事件，避免 WS 消息处理崩溃
        try {
          await this.opts.agentManager.ensureStarted(event.projectId, event.agentName, session.id);
          await this.opts.agentManager.prompt(session.id, event.text);
        } catch (err) {
          this.broadcast({ type: "error", message: `agent 启动失败: ${(err as Error).message}`, agentName: event.agentName });
        }
        break;
      }
      case "agent:abort": {
        // 新 API：只按 sessionId 中止（AgentManager 内部 Map<sessionId, AgentSession>）
        await this.opts.agentManager.abort(event.sessionId);
        break;
      }
      case "steer:promote": {
        try {
          await this.opts.agentManager.promoteToSteer(event.sessionId, event.text, event.remainingTexts);
        } catch (err) {
          this.broadcast({ type: "error", message: `引导失败: ${(err as Error).message}` });
        }
        break;
      }
      case "steer:immediate": {
        try {
          await this.opts.agentManager.immediate(event.sessionId, event.text, event.remainingTexts);
        } catch (err) {
          this.broadcast({ type: "error", message: `立即执行失败: ${(err as Error).message}` });
        }
        break;
      }
      case "steer:cancel": {
        this.opts.agentManager.clearSteeringQueue(event.sessionId);
        break;
      }
      case "steer:clear-queue": {
        this.opts.agentManager.clearFollowUpQueue(event.sessionId);
        break;
      }
      case "agent:config:get": {
        const config = await this.opts.configStore.getAgent(event.agentName) ?? makeDefaultAgentConfig(event.agentName);
        reply({ type: "agent:config", agentName: event.agentName, config });  // 定向
        break;
      }
      case "agent:config:save": {
        const errs = await this.opts.configStore.saveAgent(event.config);
        if (errs.length) reply({ type: "error", message: errs.join("; ") });
        break;
      }
      case "fs:home": {
        reply({ type: "fs:home", home: homedir() });
        break;
      }
      case "fs:roots": {
        if (process.platform === "win32") {
          const roots: string[] = [];
          for (let i = 67; i <= 90; i++) {  // 'C'(67) 到 'Z'(90)
            const drive = String.fromCharCode(i) + ":\\";
            if (existsSync(drive)) roots.push(drive);
          }
          reply({ type: "fs:roots", roots });
        } else {
          reply({ type: "fs:roots", roots: ["/"] });
        }
        break;
      }
      case "fs:listDir": {
        try {
          const dirents = await readdir(event.path, { withFileTypes: true });
          const entries: DirEntry[] = dirents
            .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
            .filter((e) => !e.name.startsWith("."));
          reply({ type: "fs:listDir", path: event.path, entries });
        } catch (e) {
          reply({ type: "fs:error", path: event.path, reason: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "provider:list": {
        const providers = await this.opts.providerStore.load();
        reply({ type: "provider:list", providers });
        break;
      }
      case "provider:save": {
        await this.opts.providerStore.save(event.provider);
        if (this.opts.dataDir) {
          await ensureProviderExtensionRegistered(this.opts.dataDir, this.opts.providerStore);
        }
        const providers = await this.opts.providerStore.load();
        this.broadcast({ type: "provider:changed", providers });
        break;
      }
      case "provider:delete": {
        await this.opts.providerStore.delete(event.id);
        if (this.opts.dataDir) {
          await ensureProviderExtensionRegistered(this.opts.dataDir, this.opts.providerStore);
        }
        const providers = await this.opts.providerStore.load();
        this.broadcast({ type: "provider:changed", providers });
        break;
      }
      case "provider:test": {
        const result = await testProviderConnection({
          baseUrl: event.baseUrl,
          apiKey: event.apiKey,
          api: event.api,
          models: event.models,
        });
        reply({ type: "provider:test", ok: result.ok, error: result.error });
        break;
      }
    }
  }
}
