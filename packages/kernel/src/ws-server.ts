import type {
  WSClientEvent, WSServerEvent, AgentName,
} from "@hiagent/shared";
import { WS_PORT } from "@hiagent/shared";
import type { DirEntry } from "@hiagent/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { AgentManager } from "./agent-manager";
import type { ProviderStore } from "./provider-store";
import type { SkillManager } from "./skill-manager";
import type { ExtensionManager } from "./extension-manager";
import type { MemoryStore } from "./memory-store";
import { testProviderConnection } from "./provider-test";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { readdir, readFile, mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { extname, basename, join } from "node:path";
import { makeDefaultAgentConfig } from "./agent-md";

function getMimeType(filePath: string): string {
  const map: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".ts": "text/typescript",
    ".tsx": "text/typescript-jsx",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
  };
  const ext = extname(filePath).toLowerCase();
  return map[ext] ?? (Bun.file(filePath).type || "application/octet-stream");
}

/** 在项目目录下生成不重复的文件路径；仅保留文件名并拒绝 `.` / `..`，防止路径穿越。 */
async function uniquePath(dir: string, name: string): Promise<string> {
  let safe = basename(name).replace(/[\\/]/g, "_") || "upload";
  if (safe === "." || safe === "..") safe = "upload";
  const candidate = join(dir, safe);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(safe);
  const stem = basename(safe, ext);
  let i = 1;
  while (true) {
    const next = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(next)) return next;
    i++;
  }
}

export async function searchFiles(
  root: string,
  query: string,
  showHidden: boolean,
  maxResults: number,
  maxDepth: number,
  onlyDirs: boolean = false,
  onMatch?: (m: DirEntry) => void,
  shouldStop?: () => boolean,
): Promise<{ matches: DirEntry[]; truncated: boolean }> {
  const lowerQuery = query.toLowerCase();
  const matches: DirEntry[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0 && matches.length < maxResults) {
    if (shouldStop?.()) break;
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    if (visited.has(dir)) continue;
    visited.add(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (!showHidden && entry.name.startsWith(".")) continue;

      const fullPath = join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (entry.name.toLowerCase().includes(lowerQuery)) {
        if (!onlyDirs || isDir) {
          const match = { name: entry.name, isDir, path: fullPath };
          matches.push(match);
          onMatch?.(match);
        }
      }
      if (isDir && !entry.isSymbolicLink()) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return { matches, truncated: matches.length >= maxResults };
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
const activeSearches = new Set<string>();

export interface WSServerOpts {
  configStore: ConfigStore;
  projectStore: ProjectStore;
  providerStore: ProviderStore;
  skillManager: SkillManager;
  extensionManager: ExtensionManager;
  memoryStore: MemoryStore;
  agentManager: AgentManager;
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
          await this.opts.agentManager.prompt(session.id, event.text, {
            model: event.model,
            thinking: event.thinking,
            attachments: event.attachments,
          });
        } catch (err) {
          this.broadcast({ type: "error", message: `agent 启动失败: ${(err as Error).message}`, agentName: event.agentName, sessionId: session.id });
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
          const entries: DirEntry[] = (await Promise.all(
            dirents.map(async (d) => {
              let isDir = d.isDirectory();
              if (d.isSymbolicLink()) {
                try {
                  const s = await stat(join(event.path, d.name));
                  isDir = s.isDirectory();
                } catch {
                  isDir = false;
                }
              }
              return { name: d.name, isDir };
            })
          )).filter((e) => event.showHidden || !e.name.startsWith("."));
          reply({ type: "fs:listDir", path: event.path, entries });
        } catch (e) {
          reply({ type: "fs:error", path: event.path, reason: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:readFile": {
        try {
          const buffer = await readFile(event.path);
          const content = buffer.toString("base64");
          const mimeType = getMimeType(event.path);
          reply({ type: "fs:readFile", path: event.path, content, mimeType });
        } catch (e) {
          reply({ type: "fs:error", path: event.path, reason: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:upload": {
        try {
          const data = await this.opts.projectStore.load();
          const project = data.projects.find(p => p.id === event.projectId);
          if (!project) throw new Error(`项目不存在: ${event.projectId}`);
          if (!project.cwd) throw new Error(`项目工作目录缺失: ${project.name ?? event.projectId}`);
          const buffer = Buffer.from(event.content, "base64");
          if (buffer.byteLength > MAX_UPLOAD_BYTES) {
            throw new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`);
          }
          const uploadDir = join(project.cwd, ".hiagent", "uploads");
          await mkdir(uploadDir, { recursive: true });
          const filePath = await uniquePath(uploadDir, event.name);
          await writeFile(filePath, buffer);
          reply({ type: "fs:upload", id: event.id, path: filePath });
        } catch (e) {
          reply({ type: "fs:upload", id: event.id, path: "", error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:copy": {
        try {
          const data = await this.opts.projectStore.load();
          const project = data.projects.find(p => p.id === event.projectId);
          if (!project) throw new Error(`项目不存在: ${event.projectId}`);
          if (!project.cwd) throw new Error(`项目工作目录缺失: ${project.name ?? event.projectId}`);

          const sourceStat = await stat(event.source);
          const isDir = sourceStat.isDirectory();

          if (isDir) {
            // 文件夹直接返回真实路径，不再创建软链接
            reply({ type: "fs:copy", id: event.id, path: event.source });
          } else {
            const uploadDir = join(project.cwd, ".hiagent", "uploads");
            await mkdir(uploadDir, { recursive: true });
            const name = basename(event.source);
            const destPath = await uniquePath(uploadDir, name);
            await copyFile(event.source, destPath);
            reply({ type: "fs:copy", id: event.id, path: destPath });
          }
        } catch (e) {
          reply({ type: "fs:copy", id: event.id, path: "", error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:search": {
        const requestId = event.requestId || crypto.randomUUID();
        activeSearches.add(requestId);
        const start = Date.now();
        const query = event.query;
        const root = event.root ?? homedir();
        const maxResults = event.maxResults ?? 100;
        const showHidden = event.showHidden ?? false;
        const onlyDirs = event.onlyDirs ?? false;

        let buffer: DirEntry[] = [];
        let lastFlush = start;
        const flush = () => {
          if (buffer.length === 0 || !activeSearches.has(requestId)) return;
          reply({
            type: "fs:search:progress",
            requestId,
            query,
            matches: buffer,
            durationMs: Date.now() - start,
            truncated: false,
          });
          buffer = [];
          lastFlush = Date.now();
        };
        const onMatch = (m: DirEntry) => {
          buffer.push(m);
          if (buffer.length >= 50 || Date.now() - lastFlush > 200) flush();
        };

        try {
          const { matches, truncated } = await searchFiles(
            root, query, showHidden, maxResults, 12, onlyDirs,
            onMatch, () => !activeSearches.has(requestId),
          );
          flush();
          if (activeSearches.has(requestId)) {
            reply({
              type: "fs:search",
              requestId,
              query,
              matches,
              durationMs: Date.now() - start,
              truncated,
            });
          }
        } catch (e) {
          if (activeSearches.has(requestId)) {
            reply({ type: "fs:search", requestId, query, matches: [], durationMs: Date.now() - start, truncated: false });
          }
        } finally {
          activeSearches.delete(requestId);
        }
        break;
      }
      case "fs:search:cancel": {
        if (event.requestId) activeSearches.delete(event.requestId);
        break;
      }
      case "provider:list": {
        const providers = await this.opts.providerStore.load();
        reply({ type: "provider:list", providers });
        break;
      }
      case "provider:save": {
        await this.opts.providerStore.save(event.provider);
        await ensureProviderExtensionRegistered(this.opts.providerStore);
        const providers = await this.opts.providerStore.load();
        this.broadcast({ type: "provider:changed", providers });
        break;
      }
      case "provider:delete": {
        await this.opts.providerStore.delete(event.id);
        await ensureProviderExtensionRegistered(this.opts.providerStore);
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
      case "skill:list": {
        try {
          const result = await this.opts.skillManager.scan();
          reply({ type: "skill:list", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "skill:toggle": {
        await this.opts.skillManager.toggleSkill(event.skillName, event.disabled);
        // reload 所有会话让禁用/启用热生效
        this.opts.agentManager.markSkillsDirty();
        const result = await this.opts.skillManager.scan();
        this.broadcast({ type: "skill:changed", ...result });
        break;
      }
      case "skillDir:add": {
        try {
          await this.opts.skillManager.addDir(event.path);
          this.opts.agentManager.markSkillsDirty();
          const result = await this.opts.skillManager.scan();
          this.broadcast({ type: "skill:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "skillDir:remove": {
        try {
          await this.opts.skillManager.removeDir(event.path);
          this.opts.agentManager.markSkillsDirty();
          const result = await this.opts.skillManager.scan();
          this.broadcast({ type: "skill:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "extension:list": {
        try {
          const { plugins } = await this.opts.extensionManager.list();
          reply({ type: "extension:list", plugins });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "extension:toggle": {
        try {
          await this.opts.extensionManager.toggle(event.id, event.enabled);
          // deferred：不立即 reload，标脏后各会话下次使用时各自 reload
          this.opts.agentManager.markAllDirty();
          const { plugins } = await this.opts.extensionManager.list();
          this.broadcast({ type: "extension:changed", plugins });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      // ===== 记忆管理 =====
      case "memory:list": {
        try {
          const result = await this.opts.memoryStore.list(event.projectId);
          reply({ type: "memory:list", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "memory:update": {
        try {
          await this.opts.memoryStore.update(event.entryId, event.text);
          const result = await this.opts.memoryStore.list(event.projectId);
          this.broadcast({ type: "memory:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "memory:archive": {
        try {
          await this.opts.memoryStore.archive(event.entryId);
          const result = await this.opts.memoryStore.list(event.projectId);
          this.broadcast({ type: "memory:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "memory:restore": {
        try {
          await this.opts.memoryStore.restore(event.entryId);
          const result = await this.opts.memoryStore.list(event.projectId);
          this.broadcast({ type: "memory:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "memory:purge": {
        try {
          await this.opts.memoryStore.purge(event.entryId);
          const result = await this.opts.memoryStore.list(event.projectId);
          this.broadcast({ type: "memory:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "instruction:list": {
        try {
          const instructions = await this.opts.memoryStore.listInstructions(event.projectId);
          reply({ type: "instruction:list", instructions });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "memory:config:get": {
        try {
          const config = await this.opts.memoryStore.getConfig();
          reply({ type: "memory:config", config });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "memory:config:set": {
        try {
          await this.opts.memoryStore.setConfig(event);
          // 配置变更后标脏所有会话，下次 idle 时 reload 读新配置
          this.opts.agentManager.markAllDirty();
          const config = await this.opts.memoryStore.getConfig();
          this.broadcast({ type: "memory:config", config });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
    }
  }
}
