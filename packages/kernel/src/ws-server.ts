import type {
  WSClientEvent, WSServerEvent, AgentName, McpServerStatus,
} from "@hiagent/shared";
import { WS_PORT, SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD, resolveSessionCwd, HIAGENT_DIR } from "@hiagent/shared";
import type { DirEntry } from "@hiagent/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { AgentManager } from "./agent-manager";
import type { ProviderStore } from "./provider-store";
import type { SkillManager } from "./skill-manager";
import type { ExtensionManager } from "./extension-manager";
import type { MemoryStore } from "./memory-store";
import type { McpStore } from "./mcp-store";
import { testProviderConnection } from "./provider-test";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { testConnection, listTools, clearAuth } from "./mcp-connector";
import { getAllCatalogModels, getProviderDisplayName } from "./pi-catalog";
import { readdir, readFile, mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { extname, basename, join, resolve, sep } from "node:path";
import { makeDefaultAgentConfig } from "./agent-md";
import { askRegistry } from "./ask-registry";
import { handleBridgeRequest } from "./bridge-registry";
import { appendChunk, finalizeRecording, discardRecording } from "./recording-store";
import { SseBus } from "./sse-bus";
import { HttpRouter } from "./http-router";
import { registerProjectSessionRoutes } from "./routes/projects-sessions";
import { registerChatRoutes } from "./routes/chat";
import { registerFsRoutes } from "./routes/fs";
import { registerAgentRoutes } from "./routes/agents";
import { registerProviderRoutes } from "./routes/providers";
import { registerSkillRoutes } from "./routes/skills";
import { registerExtensionRoutes } from "./routes/extensions";
import { registerMemoryRoutes } from "./routes/memory";
import { registerMcpRoutes } from "./routes/mcp";
import { registerFileRoutes } from "./routes/files";
import { readSessionHistory } from "./session-history";

/** 把 URL 路径解析成 staticDir 下的文件路径；未知/越权路径回退 index.html（SPA）。 */
export function resolveStaticPath(urlPath: string, staticDir: string): string {
  const clean = urlPath.split("?")[0].split("#")[0];
  // 只允许纯资产形 /a/b.c；其余（含 .. 、空、根、未知深路径）回退首页
  if (!/^\/[A-Za-z0-9_@\-./]+\.[A-Za-z0-9]+$/.test(clean)) return `${staticDir}/index.html`;
  if (clean.includes("..")) return `${staticDir}/index.html`;
  return `${staticDir}${clean}`;
}

export function getMimeType(filePath: string): string {
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
    ".webm": "audio/webm",
    ".weba": "audio/webm",
  };
  const ext = extname(filePath).toLowerCase();
  return map[ext] ?? (Bun.file(filePath).type || "application/octet-stream");
}

/**
 * 解析 /file?path=<abs>：仅当 path 解析后落在某项目 .hiagent/uploads 下才放行。
 * 防 .. 穿越与非 uploads 路径。返回安全绝对路径，否则 null。
 */
export function resolveUploadFile(url: URL, projects: { cwd: string }[]): string | null {
  const raw = url.searchParams.get("path");
  if (!raw) return null;
  const resolved = resolve(raw);              // 解析 .. 与相对段
  for (const p of projects) {
    if (!p.cwd) continue;
    const uploadsRoot = resolve(join(p.cwd, ".hiagent", "uploads"));
    // 确保是 uploadsRoot 的子路径（含 .. 的合法文件名也放行，只要最终落在 uploads 下）
    if (resolved === uploadsRoot || resolved.startsWith(uploadsRoot + sep)) return resolved;
  }
  return null;
}

/** 在项目目录下生成不重复的文件路径；仅保留文件名并拒绝 `.` / `..`，防止路径穿越。 */
export async function uniquePath(dir: string, name: string): Promise<string> {
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

/**
 * 从 fs:upload / fs:copy / fs:recording 等事件解析本次操作的 cwd。
 *
 * - 普通项目会话 / 未带 sessionId → 返回 project.cwd（行为不变）
 * - 默认工作区会话 + sessionId → 用 resolveSessionCwd 推导 ~/.hiagent/workdir/<createdAt>/
 *
 * 携带 sessionId 但 session 实体不存在时降级返回 project.cwd（保守地与旧调用方一致）。
 */
export async function resolveCwdForFsRequest(
  projectStore: ProjectStore,
  projectId: string,
  sessionId?: string,
): Promise<string> {
  const { projects, sessions } = await projectStore.load();
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  if (!project.cwd) throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);
  if (!sessionId) return project.cwd;
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return project.cwd;  // session 不存在 → 降级，保持向后兼容
  return resolveSessionCwd(session, project);
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
  mcpStore: McpStore;
  agentManager: AgentManager;
  dataDir?: string;
  port?: number;
  staticDir?: string;
}

export class WSServer {
  actualPort = 0;
  private server: any;
  private sseBus = new SseBus();
  private router = new HttpRouter();
  private sseHeartbeat: ReturnType<typeof setInterval> | null = null;
  private _promptLocks = new Map<string, Promise<void>>();
  private _abortVersions = new Map<string, number>();
  private _pendingAbortOnStart = new Set<string>(); // abort 时 agent 未启动则标记，agent_start 时执行 // abort 时递增，旧链 handler 版本不匹配则跳过

  constructor(private opts: WSServerOpts) {
    this.registerRoutes();
  }

  // 广播给所有客户端（AgentManager.onEvent 在 index.ts 里直接调此方法）
  // 去 WS 化后只走 SSE 事件总线。
  broadcast(e: WSServerEvent): void {
    // abort 时 agent 未启动则标记 pending，agent_start 广播前拦截并执行 abort
    if (e.type === "sdk:event" && (e.event as any)?.type === "agent_start") {
      const sid = (e as any).sessionId;
      if (this._pendingAbortOnStart.has(sid)) {
        this._pendingAbortOnStart.delete(sid);
        console.log(`[ws-server] PENDING abort EXEC on agent_start sessionId=${sid}`);
        this.opts.agentManager.abort(sid).catch(() => {});
        this._abortVersions.set(sid, (this._abortVersions.get(sid) ?? 0) + 1);
        return; // 不广播 agent_start，直接 abort
      }
    }
    this.sseBus.broadcast(e.type, e);
  }

  /**
   * REST 适配器：复用 handle() 业务逻辑（不改 case），把 WS 请求/响应语义映射到 HTTP。
   * - reply 中的 progress 帧 → SSE 总线（带 requestId/id，前端按 id 过滤）
   * - responseTypes 之外的 reply → SSE 总线（广播语义，如 session:echo_user / extension:changed）
   * - 其余最后一个 reply → HTTP 响应体；无 reply（fire-and-forget）→ 200 {ok:true}
   * - {type:"error"} reply → 400 {error, ...原字段}
   */
  async callApi(event: WSClientEvent, opts?: { responseTypes?: string[] }): Promise<Response> {
    const kept: WSServerEvent[] = [];
    await this.handle(event, (e) => {
      const t = (e as any).type as string;
      if (t.includes("progress") || (opts?.responseTypes && !opts.responseTypes.includes(t))) {
        this.broadcast(e);
        return;
      }
      kept.push(e);
    });
    const last = kept[kept.length - 1];
    if (!last) return Response.json({ ok: true });
    if (last.type === "error") {
      const { type: _t, message, ...rest } = last as any;
      return Response.json({ ...rest, error: message }, { status: 400 });
    }
    for (const e of kept.slice(0, -1)) this.broadcast(e);
    return Response.json(last);
  }

  /** 注册全部 REST 路由（按域分组到 routes/<domain>.ts，与 WSClientEvent 一一对应） */
  private registerRoutes(): void {
    const callApi = (e: WSClientEvent, o?: { responseTypes?: string[] }) => this.callApi(e, o);
    const ctx = { projectStore: this.opts.projectStore };
    registerProjectSessionRoutes(this.router, callApi, ctx);
    registerChatRoutes(this.router, callApi, ctx);
    registerFsRoutes(this.router, callApi, ctx);
    registerAgentRoutes(this.router, callApi, ctx);
    registerProviderRoutes(this.router, callApi, ctx);
    registerSkillRoutes(this.router, callApi, ctx);
    registerExtensionRoutes(this.router, callApi, ctx);
    registerMemoryRoutes(this.router, callApi, ctx);
    registerMcpRoutes(this.router, callApi, ctx);
    registerFileRoutes(this.router, callApi, ctx);
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.opts.port ?? WS_PORT,
      // Bun 默认 10s 空闲断连，SSE 长连接会被杀；放宽到 255s（心跳 30s 保活）
      idleTimeout: 255,
      fetch: async (req) => {
        const url = new URL(req.url);
        // SSE 事件总线：所有 kernel→前端推送经此一条流广播（去 WS 化）
        if (url.pathname === "/api/events") {
          const bus = this.sseBus;
          let write: ((chunk: string) => void) | null = null;
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              const enc = new TextEncoder();
              write = (chunk) => controller.enqueue(enc.encode(chunk));
              // 首帧注释：触发响应头冲刷（Bun 流式响应需首包才开始下发），
              // EventSource 收到注释帧忽略、但会立即进入 open 状态
              write(": connected\n\n");
              bus.add(write);
            },
            cancel: () => { if (write) bus.remove(write); },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "connection": "keep-alive",
            },
          });
        }
        // REST API（去 WS 化：复用 handle() 业务逻辑的适配器路由）
        if (url.pathname.startsWith("/api/")) {
          const res = await this.router.handle(req);
          return res ?? Response.json({ error: "not_found" }, { status: 404 });
        }
        // pi 进程内 bridge 扩展的宿主工具回调（RPC 架构下 customTools 的替代）
        if (url.pathname === "/bridge/tool") {
          if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
          let body: unknown;
          try { body = await req.json(); } catch {
            return Response.json({ error: "invalid_json" }, { status: 400 });
          }
          const r = await handleBridgeRequest(body);
          if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
          return Response.json(r.result, { status: 200 });
        }
        if (url.pathname === "/file") {
          const { projects } = await this.opts.projectStore.load();
          const filePath = resolveUploadFile(url, projects);
          if (!filePath) return new Response("Forbidden", { status: 403 });
          const file = Bun.file(filePath);
          if (file.size > 0) {
            return new Response(file, { headers: { "content-type": getMimeType(filePath) } });
          }
          return new Response("Not found", { status: 404 });
        }
        if (this.opts.staticDir) {
          const urlPath = url.pathname;
          const staticFilePath = resolveStaticPath(urlPath, this.opts.staticDir);
          const file = Bun.file(staticFilePath);
          if (file.size > 0) {
            return new Response(file, { headers: { "content-type": getMimeType(staticFilePath) } });
          }
          const indexFile = Bun.file(`${this.opts.staticDir}/index.html`);
          if (indexFile.size > 0) {
            // SPA fallback：未知路由回退到前端入口
            return new Response(indexFile, { headers: { "content-type": "text/html" } });
          }
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    this.actualPort = this.server.port;
    // SSE 心跳：30s 注释帧，防代理/空闲断连
    this.sseHeartbeat = setInterval(() => this.sseBus.heartbeat(), 30_000);
  }

  async stop(): Promise<void> {
    if (this.sseHeartbeat) { clearInterval(this.sseHeartbeat); this.sseHeartbeat = null; }
    this.server?.stop();
    await this.opts.agentManager.disposeAll();
  }

  /** 获取扩展技能路径并调用 skillManager.scan，避免每处重复获取 */
  private async scanSkillsWithExtensions() {
    const extPaths = this.opts.extensionManager
      ? await this.opts.extensionManager.getEnabledExtensionSkillPaths()
      : [];
    return this.opts.skillManager.scan(extPaths);
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
        // 默认工作区（系统项目）不可改名：拦截在所有校验/落盘之前
        if (event.projectId === SYSTEM_PROJECT_ID) {
          this.broadcast({ type: "error", message: "默认工作区不可修改" });
          break;
        }
        await this.opts.projectStore.updateProject(event.projectId, { name: event.name, cwd: event.cwd });
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "project:delete": {
        // 默认工作区（系统项目）不可删除：拦截在所有校验/落盘之前
        if (event.projectId === SYSTEM_PROJECT_ID) {
          this.broadcast({ type: "error", message: "默认工作区不可删除" });
          break;
        }
        await this.opts.projectStore.deleteProject(event.projectId);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "project:open-dir": {
        const data = await this.opts.projectStore.load();
        const project = data.projects.find(p => p.id === event.projectId);
        if (!project?.cwd) break;
        // 默认工作区会话级：若有 sessionId 用 resolveSessionCwd 推导子目录
        let dir = project.cwd;
        if (event.sessionId) {
          const session = data.sessions.find(s => s.id === event.sessionId);
          if (session) dir = resolveSessionCwd(session, project);
        }
        if (existsSync(dir)) {
          const openCmd = process.platform === "darwin" ? "open"
            : process.platform === "win32" ? "start" : "xdg-open";
          spawn(openCmd, [dir], { shell: true, stdio: "ignore" });
        }
        break;
      }
      case "session:rename": {
        await this.opts.projectStore.renameSession(event.sessionId, event.title);
        const data = await this.opts.projectStore.load();
        this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        break;
      }
      case "session:set-agent": {
        // 与 agent:prompt 的 agent_missing 拦截一致：目标智能体必须存在，
        // 否则 _createSession 会静默走默认配置，会话进入「已删除智能体」状态
        if (!(await this.opts.configStore.getAgent(event.agentName))) {
          reply({ type: "error", message: `智能体不存在: ${event.agentName}`, sessionId: event.sessionId });
          break;
        }
        try {
          await this.opts.agentManager.switchAgent(event.sessionId, event.agentName);
          this.broadcast({ type: "session:updated", sessionId: event.sessionId, primaryAgent: event.agentName });
          const data = await this.opts.projectStore.load();
          this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err), sessionId: event.sessionId });
        }
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
        const { sessions } = await this.opts.projectStore.load();
        const session = sessions.find(s => s.id === event.sessionId);
        const isActive = this.opts.agentManager.isSessionBusy(event.sessionId);
        if (!session) {
          reply({ type: "session:messages", sessionId: event.sessionId, messages: [], isActive });
          break;
        }
        if (session.piSessionFile) {
          try {
            const history = await readSessionHistory(session.piSessionFile);
            const messages = history.map(m => ({ message: m, agentName: session.primaryAgent }));
            reply({ type: "session:messages", sessionId: event.sessionId, messages, isActive });
            void this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent, session.id)
              .catch((err) => console.error(`[ws-server] 后台预热会话进程失败 ${event.sessionId}:`, err));
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
              reply({ type: "session:messages", sessionId: event.sessionId, messages: [], isActive });
              void this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent, session.id)
                .catch((e) => console.error(`[ws-server] 后台预热会话进程失败 ${event.sessionId}:`, e));
              break;
            }
            console.warn(`[ws-server] 会话文件直读失败，回退进程路径 ${event.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          const sdkSession = await this.opts.agentManager.ensureStarted(session.projectId, session.primaryAgent, session.id);
          const messages = (sdkSession.messages as any[]).map(m => ({ message: m, agentName: session.primaryAgent }));
          reply({ type: "session:messages", sessionId: event.sessionId, messages, isActive });
        } catch {
          reply({ type: "session:messages", sessionId: event.sessionId, messages: [], isActive });
        }
        break;
      }
      case "agent:prompt": {
        // 用前端传的 sessionId 查找已有 session；找不到则用该 id 创建，确保前后端一致
        // session 级串行锁：仅覆盖 ensureStarted（建会话/加载扩展等），不覆盖 am.prompt()。
        // 若把 prompt 也锁在内，空闲时 session.prompt() 会 await 整个 agent turn，导致后续
        // 排队消息等到 turn 完全结束才执行——此时 isStreaming=false 误走直发而非 followUp
        // 入队，与 steer:promote 配合导致消息重复发送（session s-e34af47e 日志确证）。
        const prevLock = this._promptLocks.get(event.sessionId) ?? Promise.resolve();
        const myVersion = this._abortVersions.get(event.sessionId) ?? 0;
        let promptReady = false; // 锁内置位：ensureStarted 成功且版本匹配，允许锁外发 prompt
        const currentLock = prevLock.then(async () => {
          const { sessions } = await this.opts.projectStore.load();
          const existing = sessions.find(s => s.id === event.sessionId);
          // 存量会话的 primaryAgent 配置已删除 → 拦截，不进入 ensureStarted
          if (existing && !(await this.opts.configStore.getAgent(existing.primaryAgent))) {
            reply({ type: "error", message: "agent_missing", sessionId: event.sessionId });
            return;
          }
          const isNew = !existing;
          // 默认工作区：先生成 ts 作为子目录名 + session.createdAt，确保两者严格一致
          // （后续 resolveSessionCwd 从 session.createdAt 推导 cwd，必须与实际目录名对齐）
          // 执行顺序：先 mkdir 子目录，成功后再 createSession 写记录——
          // 避免 mkdir 失败时留下指向不存在目录的孤儿 session 记录
          let createdAt: number | undefined;
          if (isNew && event.projectId === SYSTEM_PROJECT_ID) {
            createdAt = Date.now();
            try {
              const sessionDir = join(SYSTEM_PROJECT_CWD, String(createdAt));
              await mkdir(sessionDir, { recursive: true });
            } catch (e) {
              reply({ type: "error", message: `默认工作区会话目录创建失败: ${(e as Error).message}`, sessionId: event.sessionId });
              return;
            }
          }
          const session = existing ?? await this.opts.projectStore.createSession({
            projectId: event.projectId, primaryAgent: event.agentName,
            title: event.text.slice(0, 20),
            id: event.sessionId,
            createdAt,
          });
          if (isNew) {
            this.broadcast({ type: "session:created", session });
            reply({ type: "session:echo_user", sessionId: session.id, text: event.text, agentName: event.agentName });
          }
          await this.opts.projectStore.touchSession(session.id);
          try {
            await this.opts.agentManager.ensureStarted(event.projectId, event.agentName, session.id);
            // ensureStarted 可能耗时 5-10s，期间可能收到 abort/clear，再次检查版本
            const curVersion = this._abortVersions.get(event.sessionId) ?? 0;
            if (curVersion !== myVersion) {
              return;
            }
            promptReady = true;
          } catch (err) {
            this.broadcast({ type: "error", message: `agent 启动失败: ${(err as Error).message}`, agentName: event.agentName, sessionId: session.id });
          }
        }).finally(() => {
          if (this._promptLocks.get(event.sessionId) === currentLock) {
            this._promptLocks.delete(event.sessionId);
          }
        });
        this._promptLocks.set(event.sessionId, currentLock);
        await currentLock;
        // prompt 在锁外且不 await turn：提交即返回，不阻塞同一 ws 连接的后续消息。
        // 若 await 整个 turn，后续消息（如排队中的"2"）要等 turn 完全结束才被处理，
        // 此时 isStreaming=false 误走直发而非 followUp 入队，与 steer:promote 配合导致
        // 消息重复发送（session s-e34af47e 日志确证）。错误走 catch 广播。
        if (promptReady) {
          this.opts.agentManager.prompt(event.sessionId, event.text, {
            model: event.model,
            thinking: event.thinking,
            attachments: event.attachments,
          }).catch(err => {
            this.broadcast({ type: "error", message: `agent 启动失败: ${(err as Error).message}`, agentName: event.agentName, sessionId: event.sessionId });
          });
        }
        break;
      }
      case "agent:abort": {
        console.log(`[ws-server] agent:abort sessionId=${event.sessionId}`);
        this._abortVersions.set(event.sessionId, (this._abortVersions.get(event.sessionId) ?? 0) + 1);
        const wasStreaming = this.opts.agentManager.isSessionStreaming(event.sessionId);
        await this.opts.agentManager.abort(event.sessionId);
        if (!wasStreaming) {
          this._pendingAbortOnStart.add(event.sessionId);
          console.log(`[ws-server] PENDING abort on agent_start sessionId=${event.sessionId}`);
        }
        console.log(`[ws-server] agent:abort DONE sessionId=${event.sessionId}`);
        break;
      }
      case "agent:answer": {
        // ask_user_question 应答：直达 AskRegistry.resolve（幂等，未知 toolCallId no-op）
        askRegistry.resolve(event.sessionId, event.toolCallId, event.reply);
        break;
      }
      case "agent:cancel-ask": {
        // ask_user_question 取消：直达 AskRegistry.cancel（幂等）
        askRegistry.cancel(event.sessionId, event.toolCallId);
        break;
      }
      case "steer:message": {
        try {
          await this.opts.agentManager.steerMessage(event.sessionId, event.text);
        } catch (err) {
          this.broadcast({ type: "error", message: `引导失败: ${(err as Error).message}` });
        }
        break;
      }
      case "steer:immediate-message": {
        try {
          await this.opts.agentManager.abort(event.sessionId);
          await this.opts.agentManager.steerMessage(event.sessionId, event.text);
        } catch (err) {
          this.broadcast({ type: "error", message: `立即执行失败: ${(err as Error).message}` });
        }
        break;
      }
      case "clear-queue": {
        this.opts.agentManager.clearFollowUpList(event.sessionId);
        break;
      }

      case "agent:list": {
        reply({ type: "agent:list", agents: await this.opts.configStore.listAgents() });
        break;
      }
      case "agent:create": {
        try {
          const agent = await this.opts.configStore.createAgent(event.displayName);
          reply({ type: "agent:created", agent });
          this.broadcast({ type: "agent:list", agents: await this.opts.configStore.listAgents() });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case "agent:delete": {
        try {
          await this.opts.configStore.deleteAgent(event.name);
          reply({ type: "agent:deleted", name: event.name });
          this.broadcast({ type: "agent:list", agents: await this.opts.configStore.listAgents() });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case "agent:tools:list": {
        reply({ type: "agent:tools:list", tools: await this.opts.agentManager.listGlobalTools() });
        break;
      }
      case "agent:config:get": {
        const config = await this.opts.configStore.getAgent(event.agentName) ?? makeDefaultAgentConfig(event.agentName);
        reply({ type: "agent:config", agentName: event.agentName, config });  // 定向
        break;
      }
      case "agent:config:save": {
        // 改名（agentName 为旧 displayName，config.displayName 为新值）：走 renameAgent 并联动会话与关系网
        if (event.agentName !== event.config.displayName) {
          const errs = await this.opts.configStore.renameAgent(event.agentName, event.config);
          if (errs.length > 0) { reply({ type: "error", message: errs.join("；") }); break; }
          // 联动：会话 primaryAgent 批量改
          const { sessions } = await this.opts.projectStore.load();
          for (const s of sessions.filter(x => x.primaryAgent === event.agentName)) {
            await this.opts.projectStore.setSessionAgent(s.id, event.config.displayName);
          }
          // 联动：其他 agent 的 partners.askTo 中旧名替换为新名
          for (const a of await this.opts.configStore.listAgents()) {
            if (a.displayName !== event.config.displayName && a.partners.askTo.includes(event.agentName)) {
              a.partners.askTo = a.partners.askTo.map(n => n === event.agentName ? event.config.displayName : n);
              await this.opts.configStore.saveAgent(a);
            }
          }
          this.opts.agentManager.renameAgentSessions(event.agentName, event.config.displayName);
          const data = await this.opts.projectStore.load();
          this.broadcast({ type: "projects:list", projects: data.projects, sessions: data.sessions });
          this.broadcast({ type: "agent:list", agents: await this.opts.configStore.listAgents() });
          break;
        }
        const errs = await this.opts.configStore.saveAgent(event.config);
        if (errs.length) { reply({ type: "error", message: errs.join("; ") }); break; }
        this.broadcast({ type: "agent:list", agents: await this.opts.configStore.listAgents() });
        break;
      }
      case "subagent:list": {
        try {
          const { loadSubagentOverrides } = await import("./subagent-store");
          const { getSubagentInfo } = await import("./subagent-info");
          const { SUBAGENT_OVERRIDES_FILE } = await import("@hiagent/shared");
          const overrides = await loadSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
          const subagents = await getSubagentInfo(overrides);
          reply({ type: "subagent:list", subagents });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case "subagent:save-override": {
        try {
          const { saveSubagentOverride, loadSubagentOverrides } = await import("./subagent-store");
          const { getSubagentInfo } = await import("./subagent-info");
          const { SUBAGENT_OVERRIDES_FILE } = await import("@hiagent/shared");
          await saveSubagentOverride(SUBAGENT_OVERRIDES_FILE, event.override);
          const overrides = await loadSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
          const subagents = await getSubagentInfo(overrides);
          // 保存后广播更新列表给所有前端
          reply({ type: "subagent:list", subagents });
        } catch (err) {
          reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
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
          const cwd = await resolveCwdForFsRequest(this.opts.projectStore, event.projectId, event.sessionId);
          const buffer = Buffer.from(event.content, "base64");
          if (buffer.byteLength > MAX_UPLOAD_BYTES) {
            throw new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`);
          }
          const uploadDir = join(cwd, ".hiagent", "uploads");
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
          const cwd = await resolveCwdForFsRequest(this.opts.projectStore, event.projectId, event.sessionId);
          const sourceStat = await stat(event.source);
          const isDir = sourceStat.isDirectory();

          if (isDir) {
            // 文件夹直接返回真实路径，不再创建软链接
            reply({ type: "fs:copy", id: event.id, path: event.source });
          } else {
            const uploadDir = join(cwd, ".hiagent", "uploads");
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
      case "fs:recording:append": {
        try {
          const cwd = await resolveCwdForFsRequest(this.opts.projectStore, event.projectId, event.sessionId);
          const uploadDir = join(cwd, ".hiagent", "uploads");
          await appendChunk(uploadDir, event.recId, event.chunk);
          reply({ type: "fs:recording:append", id: event.id });
        } catch (e) {
          reply({ type: "fs:recording:append", id: event.id, error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:recording:finalize": {
        try {
          const cwd = await resolveCwdForFsRequest(this.opts.projectStore, event.projectId, event.sessionId);
          const uploadDir = join(cwd, ".hiagent", "uploads");
          const path = await finalizeRecording(uploadDir, event.recId, event.finalName);
          reply({ type: "fs:recording:finalize", id: event.id, path });
        } catch (e) {
          reply({ type: "fs:recording:finalize", id: event.id, path: "", error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:recording:discard": {
        try {
          const cwd = await resolveCwdForFsRequest(this.opts.projectStore, event.projectId, event.sessionId);
          const uploadDir = join(cwd, ".hiagent", "uploads");
          await discardRecording(uploadDir, event.recId);
          reply({ type: "fs:recording:discard", id: event.id });
        } catch (e) {
          reply({ type: "fs:recording:discard", id: event.id, error: String(e instanceof Error ? e.message : e) });
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
      case "model:presets": {
        try {
          // pi 内置模型目录（pi-catalog.ts，只读数据，不经 SDK）
          const all = await getAllCatalogModels();
          const map = new Map<string, any>();
          for (const m of all) {
            const k = m.provider;
            if (!map.has(k)) map.set(k, { key: k, name: (await getProviderDisplayName(k)) || k, baseUrl: m.baseUrl || "", api: m.api || "openai-completions", models: [] as any[] });
            const e = map.get(k)!;
            if (!e.baseUrl && m.baseUrl) e.baseUrl = m.baseUrl;
            e.models.push({ id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, supportsVision: (m.input as string[])?.includes("image") ?? false });
          }
          const presets = Array.from(map.values()).filter((p: any) => p.models.length > 0).sort((a: any, b: any) => a.key.localeCompare(b.key));
          reply({ type: "model:presets", presets });
        } catch (err) {
          console.error("[ws] model:presets error:", err);
          reply({ type: "model:presets", presets: [] });
        }
        break;
      }
      case "skill:list": {
        try {
          const result = await this.scanSkillsWithExtensions();
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
        const result = await this.scanSkillsWithExtensions();
        this.broadcast({ type: "skill:changed", ...result });
        break;
      }
      case "skillDir:add": {
        try {
          await this.opts.skillManager.addDir(event.path);
          this.opts.agentManager.markSkillsDirty();
          const result = await this.scanSkillsWithExtensions();
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
          const result = await this.scanSkillsWithExtensions();
          this.broadcast({ type: "skill:changed", ...result });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "extension:list": {
        try {
          const { packages } = await this.opts.extensionManager.list();
          reply({ type: "extension:list", packages });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "extension:toggle": {
        try {
          if (event.enabled) {
            await this.opts.extensionManager.enable(event.name);
          } else {
            await this.opts.extensionManager.disable(event.name);
          }
          this.opts.agentManager.markAllDirty();
          const { packages } = await this.opts.extensionManager.list();
          this.broadcast({ type: "extension:changed", packages });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "extension:install": {
        try {
          // 包管理器日志行流式回推给请求者（仅请求者持有占位卡片）
          const onProgress = (message: string) =>
            reply({ type: "extension:progress", name: event.name, message });
          await this.opts.extensionManager.install(event.name, onProgress);
          this.opts.agentManager.markAllDirty();
          const { packages } = await this.opts.extensionManager.list();
          this.broadcast({ type: "extension:changed", packages });
          reply({ type: "extension:changed", packages });
          // 成功终态：前端据此清除占位卡（真实卡片由上面的 changed 提供）
          reply({ type: "extension:install:done", name: event.name });
        } catch (err) {
          reply({ type: "extension:error", name: event.name, error: (err as Error).message });
        }
        break;
      }
      case "extension:uninstall": {
        try {
          await this.opts.extensionManager.uninstall(event.name);
          this.opts.agentManager.markAllDirty();
          const { packages } = await this.opts.extensionManager.list();
          this.broadcast({ type: "extension:changed", packages });
        } catch (err) {
          reply({ type: "extension:error", name: event.name, error: (err as Error).message });
        }
        break;
      }
      case "extension:upgrade": {
        try {
          // 包管理器日志行流式回推给请求者（与 install 一致）
          const onProgress = (message: string) =>
            reply({ type: "extension:progress", name: event.name, message });
          await this.opts.extensionManager.upgrade(event.name, onProgress);
          this.opts.agentManager.markAllDirty();
          const { packages } = await this.opts.extensionManager.list();
          this.broadcast({ type: "extension:changed", packages });
          reply({ type: "extension:changed", packages });
        } catch (err) {
          reply({ type: "extension:error", name: event.name, error: (err as Error).message });
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
      case "memory:add": {
        try {
          await this.opts.memoryStore.add(event.scope, event.text, event.projectId);
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
      // ===== MCP 连接器 =====
      case "mcp:list": {
        try {
          const servers = await this.opts.mcpStore.list(event.projectId);
          reply({ type: "mcp:list", projectId: event.projectId, servers });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:save": {
        try {
          await this.opts.mcpStore.save(event.config, event.projectId, event.originalName);
          const servers = await this.opts.mcpStore.list(event.projectId);
          this.broadcast({ type: "mcp:changed", projectId: event.projectId, servers });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:delete": {
        try {
          await this.opts.mcpStore.delete(event.serverName, event.projectId);
          const servers = await this.opts.mcpStore.list(event.projectId);
          this.broadcast({ type: "mcp:changed", projectId: event.projectId, servers });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:test": {
        try {
          const config = await this.opts.mcpStore.getServer(event.serverName, event.projectId);
          const cwd = await this.resolveProjectCwd(event.projectId);
          const outcome = await testConnection(config, cwd);
          reply({
            type: "mcp:testResult",
            serverName: event.serverName,
            success: outcome.status === "connected",
            status: outcome.status,
            toolCount: outcome.toolCount,
            error: outcome.error,
          });
        } catch (err) {
          reply({ type: "mcp:testResult", serverName: event.serverName, success: false, status: "error", error: (err as Error).message });
        }
        break;
      }
      case "mcp:listTools": {
        try {
          const config = await this.opts.mcpStore.getServer(event.serverName, event.projectId);
          const cwd = await this.resolveProjectCwd(event.projectId);
          const tools = await listTools(config, cwd);
          reply({ type: "mcp:tools", serverName: event.serverName, tools });
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        break;
      }
      case "mcp:clearAuth": {
        try {
          await clearAuth(event.serverName);
          // 清除授权后：OAuth 服务器回到 needs_auth（可重新授权）；其它回到 disconnected
          const config = await this.opts.mcpStore.getServer(event.serverName, event.projectId).catch(() => null);
          const status: McpServerStatus = config?.auth === "oauth" ? "needs_auth" : "disconnected";
          reply({ type: "mcp:testResult", serverName: event.serverName, success: true, status });
        } catch (err) {
          reply({ type: "mcp:testResult", serverName: event.serverName, success: false, status: "error", error: (err as Error).message });
        }
        break;
      }
    }
  }

  /** 解析项目工作目录；无 projectId（全局作用域）返回 undefined */
  private async resolveProjectCwd(projectId?: string): Promise<string | undefined> {
    if (!projectId) return undefined;
    const { projects } = await this.opts.projectStore.load();
    return projects.find(p => p.id === projectId)?.cwd;
  }
}
