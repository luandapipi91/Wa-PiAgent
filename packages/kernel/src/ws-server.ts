import type {
	WSClientEvent,
	WSServerEvent,
	McpServerStatus,
	McpToolSummary,
	TokenUsageSummary,
} from "@wa-pi/shared";
import {
	WS_PORT,
	SYSTEM_PROJECT_ID,
	SYSTEM_PROJECT_CWD,
	resolveSessionCwd,
	SCHEDULED_TASKS_FILE,
	EXECUTION_RECORDS_FILE,
} from "@wa-pi/shared";
import type { DirEntry } from "@wa-pi/shared";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";
import type { AgentManager } from "./agent-manager";
import type { ProviderStore } from "./provider-store";
import type { SkillManager } from "./skill-manager";
import type { ExtensionManager } from "./extension-manager";
import type { MemoryStore } from "./memory-store";
import type { McpStore } from "./mcp-store";
import { testProviderConnection } from "./provider-test";
import {
	loadRetrySettings,
	saveRetrySettings,
	loadHttpIdleTimeoutMs,
	saveHttpIdleTimeoutMs,
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
} from "./settings-store";
import { ensureProviderExtensionRegistered, resolveProviderBaseUrl } from "./provider-extension";
import { testConnection, listTools, clearAuth } from "./mcp-connector";
import { getAllCatalogModels, getProviderDisplayName } from "./pi-catalog";
import {
	readdir,
	readFile,
	mkdir,
	writeFile,
	copyFile,
	stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { extname, basename, join, resolve, sep } from "node:path";
import { makeDefaultAgentConfig } from "./agent-md";
import { askRegistry } from "./ask-registry";
import { extUiRegistry } from "./ext-ui-registry";
import {
	handleBridgeRequest,
	handleBridgeStream,
	isBridgeStreamTool,
} from "./bridge-registry";
import {
	appendChunk,
	finalizeRecording,
	discardRecording,
} from "./recording-store";
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
import { registerSettingsRoutes } from "./routes/settings";
import { registerChannelRoutes } from "./routes/channels";
import { createSchedulerRoutes } from "./routes/scheduler";
import { registerContactRoutes } from "./routes/contacts";
import { ChannelConflictError } from "./channel-manager";
import { registerFileRoutes } from "./routes/files";
import type { TaskScheduler } from "./scheduler";
import { readSessionHistory, computeSessionUsage } from "./session-history";
import { listPresets, getPreset, createAgentFromPreset } from "./preset-store";

/** 展开路径开头的 ~ 为 HOME 目录（Node.js 不自动展开 shell ~ 约定） */
function expandTilde(p: string): string {
	if (p.startsWith("~")) {
		return p.replace(/^~/, homedir());
	}
	return p;
}

/** 在目录下递归搜索指定文件名，返回第一个匹配的绝对路径（深度最浅优先） */
async function findFileByBasename(
	root: string,
	name: string,
): Promise<string | null> {
	try {
		const entries = await readdir(root, { recursive: true });
		const matches = entries
			.filter((e) => basename(e) === name)
			.sort((a, b) => a.split(sep).length - b.split(sep).length);
		if (matches.length === 1) return join(root, matches[0]);
	} catch {
		/* 目录不可读则跳过 */
	}
	return null;
}

/** 预览上限：3MB */
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

async function checkPreviewable(
	absPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const mime = getMimeType(absPath);
	const isText =
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/xml" ||
		mime === "image/svg+xml";
	if (!isText) return { ok: false, reason: `不支持的文件类型: ${mime}` };
	try {
		const s = await stat(absPath);
		if (s.size > MAX_PREVIEW_BYTES)
			return {
				ok: false,
				reason: `文件过大 (${(s.size / 1024 / 1024).toFixed(1)}MB > ${MAX_PREVIEW_BYTES / 1024 / 1024}MB)`,
			};
	} catch {
		return { ok: false, reason: "无法获取文件信息" };
	}
	return { ok: true };
}

/** 把 URL 路径解析成 staticDir 下的文件路径；未知/越权路径回退 index.html（SPA）。 */
export function resolveStaticPath(urlPath: string, staticDir: string): string {
	const clean = urlPath.split("?")[0].split("#")[0];
	// 只允许纯资产形 /a/b.c；其余（含 .. 、空、根、未知深路径）回退首页
	if (!/^\/[A-Za-z0-9_@\-./]+\.[A-Za-z0-9]+$/.test(clean))
		return `${staticDir}/index.html`;
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
 * 解析 /file?path=<abs>：仅当 path 解析后落在某项目 .wa-pi/uploads 下才放行。
 * 防 .. 穿越与非 uploads 路径。返回安全绝对路径，否则 null。
 */
export function resolveUploadFile(
	url: URL,
	projects: { cwd: string }[],
): string | null {
	const raw = url.searchParams.get("path");
	if (!raw) return null;
	const resolved = resolve(raw); // 解析 .. 与相对段
	for (const p of projects) {
		if (!p.cwd) continue;
		const uploadsRoot = resolve(join(p.cwd, ".wa-pi", "uploads"));
		// 确保是 uploadsRoot 的子路径（含 .. 的合法文件名也放行，只要最终落在 uploads 下）
		if (resolved === uploadsRoot || resolved.startsWith(uploadsRoot + sep))
			return resolved;
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
 * - 默认工作区会话 + sessionId → 用 resolveSessionCwd 推导 ~/.pi/agent/workdir/<createdAt>/
 *
 * 携带 sessionId 但 session 实体不存在时降级返回 project.cwd（保守地与旧调用方一致）。
 */
export async function resolveCwdForFsRequest(
	projectStore: ProjectStore,
	projectId: string,
	sessionId?: string,
): Promise<string> {
	const { projects, sessions } = await projectStore.load();
	const project = projects.find((p) => p.id === projectId);
	if (!project) throw new Error(`项目不存在: ${projectId}`);
	if (!project.cwd)
		throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);
	if (!sessionId) return project.cwd;
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) return project.cwd; // session 不存在 → 降级，保持向后兼容
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
	/** IM 渠道机器人管理器（Task 8 注入真实实例；测试/未启用时为 null，相关 case 走降级路径） */
	channelManager: import("./channel-manager").ChannelManager | null;
	dataDir?: string;
	/** provider-extension.ts 输出目录（测试注入临时目录，避免覆盖真实 GENERATED_DIR） */
	generatedDir?: string;
	/** 测试钩子：bridge 流式响应被消费方取消（断连）时回调，生产环境不传 */
	onBridgeStreamCancel?: () => void;
	port?: number;
	staticDir?: string;
}

/**
 * 归一化 pi get_session_stats 的 contextUsage 字段（版本差异：
 * 新版本 tokens/contextWindow/percent，旧版本 used/total/ratio），
 * 统一输出前端使用的 { used, total, ratio }。
 */
function normalizeContextUsage(
	cu: any,
): { used: number; total: number; ratio: number } | null {
	if (!cu || typeof cu !== "object") return null;
	const used = cu.used ?? cu.tokens;
	const total = cu.total ?? cu.contextWindow;
	if (typeof used !== "number" || typeof total !== "number" || total <= 0) {
		return null;
	}
	const ratio =
		cu.ratio ??
		(typeof cu.percent === "number" ? cu.percent / 100 : used / total);
	return { used, total, ratio };
}

/** pi tokens 字段（可选/缺 total）归一化为完整 TokenUsageSummary */
export function toTokenSummary(t: any): TokenUsageSummary {
	const input = t?.input ?? 0;
	const output = t?.output ?? 0;
	const cacheRead = t?.cacheRead ?? 0;
	const cacheWrite = t?.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: t?.total ?? input + output + cacheRead + cacheWrite,
	};
}

/**
 * 合并主代理用量与子代理累计：返回平铺合计 + main/subagent 拆分。
 * session:stats 的降级路径（jsonl 扫描拆分）走这里。
 */
export function mergeTokenUsage(
	main: TokenUsageSummary,
	subagent?: TokenUsageSummary,
): TokenUsageSummary & {
	main: TokenUsageSummary;
	subagent: TokenUsageSummary;
} {
	const sub = subagent ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	return {
		input: main.input + sub.input,
		output: main.output + sub.output,
		cacheRead: main.cacheRead + sub.cacheRead,
		cacheWrite: main.cacheWrite + sub.cacheWrite,
		total: main.total + sub.total,
		main,
		subagent: sub,
	};
}

/**
 * 官方路径拆分：pi tokens 已含子代理消耗（toolResult.usage），
 * main = 合计 − 子代理（逐项 clamp ≥0，防御旧 jsonl 无 toolResult.usage 的会话）。
 */
export function splitOfficialTokens(
	total: TokenUsageSummary,
	subagent?: TokenUsageSummary,
): TokenUsageSummary & {
	main: TokenUsageSummary;
	subagent: TokenUsageSummary;
} {
	const sub = subagent ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	};
	const clamp = (n: number) => Math.max(0, n);
	return {
		...total,
		main: {
			input: clamp(total.input - sub.input),
			output: clamp(total.output - sub.output),
			cacheRead: clamp(total.cacheRead - sub.cacheRead),
			cacheWrite: clamp(total.cacheWrite - sub.cacheWrite),
			total: clamp(total.total - sub.total),
		},
		subagent: sub,
	};
}

export class WSServer {
	actualPort = 0;
	private server: any;
	private sseBus = new SseBus();
	private router = new HttpRouter();
	private sseHeartbeat: ReturnType<typeof setInterval> | null = null;
	/** 定时任务调度器（后续任务注入实例；null 时路由 CRUD 仍可用，仅跳过 cron 同步） */
	private scheduler: TaskScheduler | null = null;
	private _promptLocks = new Map<string, Promise<void>>();
	private _abortVersions = new Map<string, number>();
	private _pendingAbortOnStart = new Set<string>(); // abort 时 agent 未启动则标记，agent_start 时执行 // abort 时递增，旧链 handler 版本不匹配则跳过

	constructor(private opts: WSServerOpts) {
		this.registerRoutes();
	}

	/** 注入定时任务调度器实例（index.ts 在 AgentManager/ChannelManager 就绪后调用） */
	setScheduler(scheduler: TaskScheduler): void {
		this.scheduler = scheduler;
	}

	// 广播给所有客户端（AgentManager.onEvent 在 index.ts 里直接调此方法）
	// 去 WS 化后只走 SSE 事件总线。
	broadcast(e: WSServerEvent): void {
		// abort 时 agent 未启动则标记 pending，agent_start 广播前拦截并执行 abort
		if (e.type === "sdk:event" && (e.event as any)?.type === "agent_start") {
			const sid = (e as any).sessionId;
			if (this._pendingAbortOnStart.has(sid)) {
				this._pendingAbortOnStart.delete(sid);
				console.log(
					`[ws-server] PENDING abort EXEC on agent_start sessionId=${sid}`,
				);
				this.opts.agentManager.abort(sid).catch(() => {});
				this._abortVersions.set(sid, (this._abortVersions.get(sid) ?? 0) + 1);
				return; // 不广播 agent_start，直接 abort
			}
		}
		this.sseBus.broadcast(e.type, e);
	}

	/**
	 * 广播当前活跃项目/会话列表（projects:list）。
	 * 统一封装 loadActive + broadcast——过滤已软删除会话，供各 handler 写操作后刷新侧栏。
	 * 公开方法：index.ts 的 archiveStaleSessions/purgeOldTrashSessions 定时任务也调用。
	 */
	async broadcastProjectsList(): Promise<void> {
		const data = await this.opts.projectStore.loadActive();
		this.broadcast({
			type: "projects:list",
			projects: data.projects,
			sessions: data.sessions,
		});
	}

	/**
	 * REST 适配器：复用 handle() 业务逻辑（不改 case），把 WS 请求/响应语义映射到 HTTP。
	 * - reply 中的 progress 帧 → SSE 总线（带 requestId/id，前端按 id 过滤）
	 * - responseTypes 之外的 reply → SSE 总线（广播语义，如 session:echo_user / extension:changed）
	 * - 其余最后一个 reply → HTTP 响应体；无 reply（fire-and-forget）→ 200 {ok:true}
	 * - {type:"error"} reply → 400 {error, ...原字段}；reply 携带 status 字段时按其映射（如 409 冲突）
	 */
	async callApi(
		event: WSClientEvent,
		opts?: { responseTypes?: string[] },
	): Promise<Response> {
		const kept: WSServerEvent[] = [];
		await this.handle(event, (e) => {
			const t = (e as any).type as string;
			if (
				t.includes("progress") ||
				(opts?.responseTypes && !opts.responseTypes.includes(t))
			) {
				this.broadcast(e);
				return;
			}
			kept.push(e);
		});
		const last = kept[kept.length - 1];
		if (!last) return Response.json({ ok: true });
		if (last.type === "error") {
			const { type: _t, message, status, ...rest } = last as any;
			const code = typeof status === "number" ? status : 400;
			return Response.json({ ...rest, error: message }, { status: code });
		}
		for (const e of kept.slice(0, -1)) this.broadcast(e);
		return Response.json(last);
	}

	/** 注册全部 REST 路由（按域分组到 routes/<domain>.ts，与 WSClientEvent 一一对应） */
	private registerRoutes(): void {
		const callApi = (e: WSClientEvent, o?: { responseTypes?: string[] }) =>
			this.callApi(e, o);
		const ctx = {
			projectStore: this.opts.projectStore,
			markAllDirty: () => this.opts.agentManager.markAllDirty(),
		};
		registerProjectSessionRoutes(this.router, callApi, ctx);
		registerChatRoutes(this.router, callApi, ctx);
		registerFsRoutes(this.router, callApi, ctx);
		registerAgentRoutes(this.router, callApi, ctx);
		registerProviderRoutes(this.router, callApi, ctx);
		registerSkillRoutes(this.router, callApi, ctx);
		registerExtensionRoutes(this.router, callApi, ctx);
		registerMemoryRoutes(this.router, callApi, ctx);
		registerMcpRoutes(this.router, callApi, ctx);
		registerSettingsRoutes(this.router, callApi, ctx);
		registerChannelRoutes(this.router, callApi, ctx);
		registerContactRoutes(this.router, callApi, ctx);
		registerFileRoutes(this.router, callApi, ctx);

		// 定时任务路由：直接读写 JSON 文件，不走 callApi 适配器
		const schedulerRoutes = createSchedulerRoutes(
			SCHEDULED_TASKS_FILE,
			EXECUTION_RECORDS_FILE,
			(task) => {
				// 调度注册失败（cron 非法等）不让已落盘的 CRUD 返回 500：
				// 记日志 + 广播 error 事件让前端感知，任务本身已保存
				try {
					this.scheduler?.scheduleTask(task);
				} catch (err) {
					console.warn(
						`[scheduler] 任务 ${task.id}（${task.name}）调度注册失败:`,
						err,
					);
					this.broadcast({
						type: "scheduled-task:error",
						taskId: task.id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				// 任务变更后广播通知前端刷新列表
				this.broadcast({ type: "scheduled-tasks:changed" });
			},
			(taskId) => {
				this.scheduler?.cancelTask(taskId);
				this.broadcast({ type: "scheduled-tasks:changed" });
			},
			async (taskId) => {
				// 立即执行：委托 scheduler 执行并广播结果
				await this.scheduler?.runTaskNow(taskId);
			},
		);
		schedulerRoutes(this.router, callApi, ctx);
	}

	async start(): Promise<void> {
		this.server = Bun.serve({
			port: this.opts.port ?? WS_PORT,
			// Bun 默认 10s 空闲断连，SSE 长连接会被杀；放宽到 255s（心跳 30s 保活）
			idleTimeout: 255,
			fetch: async (req) => {
				let url: URL;
				try {
					url = new URL(req.url);
				} catch {
					return new Response("Invalid URL", { status: 400 });
				}
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
						cancel: () => {
							if (write) bus.remove(write);
						},
					});
					return new Response(stream, {
						headers: {
							"content-type": "text/event-stream",
							"cache-control": "no-cache",
							connection: "keep-alive",
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
					if (req.method !== "POST")
						return new Response("Method Not Allowed", { status: 405 });
					let body: unknown;
					try {
						body = await req.json();
					} catch {
						return Response.json({ error: "invalid_json" }, { status: 400 });
					}
					// 诊断：记录每次宿主工具调用（崩溃定位——看最后调的工具）
					const toolName = (body as any)?.tool;
					if (toolName) console.log(`[kernel] bridge tool: ${toolName}`);

					// 流式分支：delegate/fleet/ask_user_question 返回 NDJSON 流（边执行边 enqueue，立即返回 Response）；
					// 其余工具走旧同步 JSON。
					if (isBridgeStreamTool(toolName)) {
						const enc = new TextEncoder();
						let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
							null;
						// 消费方中断（如「停止消息」导致 pi 侧 abort fetch）后 Bun 会 cancel 本流，
						// 此后 enqueue/close 都会抛 "Controller is already closed"。子代理可能仍在
						// 跑并继续产出 progress，必须用 closed 标记 + try 防护切断后续写入，
						// 否则同步 throw 沿子代理 stdout 回调链冒泡成 unhandledRejection 内核异常。
						let closed = false;
						const onStreamCancel = this.opts.onBridgeStreamCancel;
						// 消费方断连时中止 kernel 侧正在执行的 delegate/fleet：
						// cancel() 是唯一可靠的断连感知点（Bun 流式响应在客户端 abort 时触发 cancel）
						const streamAbort = new AbortController();
						const stream = new ReadableStream<Uint8Array>({
							start(controller) {
								controllerRef = controller;
							},
							cancel() {
								closed = true;
								controllerRef = null;
								// 客户端断连 → 中止子代理执行（防孤儿子代理跑满 30min settle 超时）
								streamAbort.abort();
								// 测试钩子：通知调用方服务端已感知断连（确定性等待用）
								onStreamCancel?.();
							},
						});
						const writeLine = (line: string) => {
							if (closed || !controllerRef) return;
							try {
								controllerRef.enqueue(enc.encode(line));
							} catch {
								closed = true;
								controllerRef = null;
							}
						};
						const closeStream = () => {
							if (closed) return;
							closed = true;
							try {
								controllerRef?.close();
							} catch {
								/* 已关闭 */
							}
							controllerRef = null;
						};
						// 关键时序：不 await，后台执行。立即 return Response 让消费方拿到响应头
						// （满足 headersTimeout），handleBridgeStream 边跑边 enqueue 进度帧
						// （消费方边读边收到，重置 bodyTimeout，避免 undici idle 空闲断连）。
						void handleBridgeStream(body, writeLine, {
							signal: streamAbort.signal,
						})
							.then((r) => {
								if (r) {
									// 流式工具返回了非 null：说明 handleBridgeStream 在写帧前
									// 因 token / body / session 校验失败而提前 return（返回 BridgeResponse）。
									// HTTP 已恒为 200，把错误合成成 final 帧 enqueue，保持 NDJSON
									// 协议一致（消费方读 final 帧 ok=false 即知出错）。
									const frame = {
										type: "final" as const,
										tool: toolName,
										toolCallId: (body as any)?.toolCallId,
										ok: false,
										error: r.ok ? undefined : r.error,
									};
									writeLine(JSON.stringify(frame) + "\n");
								}
								closeStream();
							})
							.catch(() => {
								closeStream();
							});
						return new Response(stream, {
							headers: {
								"content-type": "application/x-ndjson",
								"cache-control": "no-cache",
							},
						});
					}

					// 非流式工具（ask/memory）：旧同步 JSON 路径。
					// 透传 req.signal：客户端断连（pi 侧空闲超时/进程退出）时 abort，
					// 让 askRegistry 里的 pending ask 以 cancelled 解决，防僵尸提问。
					const r = await handleBridgeRequest(body, req.signal);
					if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
					return Response.json(r.result, { status: 200 });
				}
				if (url.pathname === "/file") {
					const { projects } = await this.opts.projectStore.load();
					const filePath = resolveUploadFile(url, projects);
					if (!filePath) return new Response("Forbidden", { status: 403 });
					const file = Bun.file(filePath);
					if (file.size > 0) {
						return new Response(file, {
							headers: { "content-type": getMimeType(filePath) },
						});
					}
					return new Response("Not found", { status: 404 });
				}
				if (this.opts.staticDir) {
					const urlPath = url.pathname;
					const staticFilePath = resolveStaticPath(urlPath, this.opts.staticDir);
					const file = Bun.file(staticFilePath);
					if (file.size > 0) {
						return new Response(file, {
							headers: { "content-type": getMimeType(staticFilePath) },
						});
					}
					const indexFile = Bun.file(`${this.opts.staticDir}/index.html`);
					if (indexFile.size > 0) {
						// SPA fallback：未知路由回退到前端入口
						return new Response(indexFile, {
							headers: { "content-type": "text/html" },
						});
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
		if (this.sseHeartbeat) {
			clearInterval(this.sseHeartbeat);
			this.sseHeartbeat = null;
		}
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

	private async handle(
		event: WSClientEvent,
		reply: (e: WSServerEvent) => void,
	): Promise<void> {
		switch (event.type) {
			case "projects:list": {
				const { projects, sessions } = await this.opts.projectStore.loadActive();
				reply({ type: "projects:list", projects, sessions }); // 定向回请求者
				break;
			}
			case "project:create": {
				const project = await this.opts.projectStore.createProject({
					name: event.name,
					cwd: event.cwd,
				});
				this.broadcast({ type: "project:created", project }); // 广播：所有客户端同步
				break;
			}
			case "project:update": {
				// 默认工作区（系统项目）不可改名：拦截在所有校验/落盘之前
				if (event.projectId === SYSTEM_PROJECT_ID) {
					this.broadcast({ type: "error", message: "默认工作区不可修改" });
					break;
				}
				await this.opts.projectStore.updateProject(event.projectId, {
					name: event.name,
					cwd: event.cwd,
				});
				await this.broadcastProjectsList();
				break;
			}
			case "project:delete": {
				// 默认工作区（系统项目）不可删除：拦截在所有校验/落盘之前
				if (event.projectId === SYSTEM_PROJECT_ID) {
					this.broadcast({ type: "error", message: "默认工作区不可删除" });
					break;
				}
				await this.opts.projectStore.deleteProject(event.projectId);
				await this.broadcastProjectsList();
				break;
			}
			case "project:open-dir": {
				const data = await this.opts.projectStore.load();
				const project = data.projects.find((p) => p.id === event.projectId);
				if (!project?.cwd) break;
				// 默认工作区会话级：若有 sessionId 用 resolveSessionCwd 推导子目录
				let dir = project.cwd;
				if (event.sessionId) {
					const session = data.sessions.find((s) => s.id === event.sessionId);
					if (session) dir = resolveSessionCwd(session, project);
				}
				if (existsSync(dir)) {
					const openCmd =
						process.platform === "darwin"
							? "open"
							: process.platform === "win32"
								? "start"
								: "xdg-open";
					spawn(openCmd, [dir], { shell: true, stdio: "ignore" });
				}
				break;
			}
			case "session:rename": {
				await this.opts.projectStore.renameSession(event.sessionId, event.title);
				await this.broadcastProjectsList();
				break;
			}
			case "session:set-agent": {
				// 与 agent:prompt 的 agent_missing 拦截一致：目标智能体必须存在，
				// 否则 _createSession 会静默走默认配置，会话进入「已删除智能体」状态
				if (!(await this.opts.configStore.getAgent(event.agentName))) {
					reply({
						type: "error",
						message: `智能体不存在: ${event.agentName}`,
						sessionId: event.sessionId,
					});
					break;
				}
				try {
					await this.opts.agentManager.switchAgent(event.sessionId, event.agentName);
					this.broadcast({
						type: "session:updated",
						sessionId: event.sessionId,
						primaryAgent: event.agentName,
					});
					await this.broadcastProjectsList();
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
						sessionId: event.sessionId,
					});
				}
				break;
			}
			case "session:reload": {
				try {
					await this.opts.agentManager.reloadSession(event.sessionId);
					// 重建后 broadcast 更新列表（重建可能改变 session 的 piSessionFile 等）
					await this.broadcastProjectsList();
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
						sessionId: event.sessionId,
					});
				}
				break;
			}
			case "session:commands": {
				try {
					const commands = await this.opts.agentManager.getCommands(
						event.sessionId,
						(event as any).projectId,
						(event as any).agentName,
					);
					reply({
						type: "session:commands",
						sessionId: event.sessionId,
						commands,
					});
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
						sessionId: event.sessionId,
					});
				}
				break;
			}
			case "session:delete": {
				// 先清理 SDK session（解绑事件订阅 + dispose），再删 ProjectStore 里的会话记录
				await this.opts.agentManager.disposeSession(event.sessionId);
				await this.opts.projectStore.deleteSession(event.sessionId);
				await this.broadcastProjectsList();
				// 联动清理 IM 映射（当前指针 + 历史归档），刷新 IM tab 列表。
				// 非 IM 会话在 mapping 里查不到 → no-op。
				if (this.opts.channelManager) {
					await this.opts.channelManager.onSessionDeleted(event.sessionId);
				}
				break;
			}
			// ===== 回收站（软删除）WS 事件 =====
			case "trash:list": {
				const result = await this.opts.projectStore.loadTrash({
					projectId: event.projectId,
					offset: event.offset,
					limit: event.limit ?? 100,
				});
				const { projects } = await this.opts.projectStore.load();
				reply({
					type: "trash:list",
					sessions: result.sessions,
					projects,
					total: result.total,
				});
				break;
			}
			case "trash:restore": {
				for (const id of event.sessionIds) {
					await this.opts.projectStore.restoreSession(id);
				}
				await this.broadcastProjectsList();
				reply({ type: "trash:op", success: true });
				break;
			}
			case "trash:delete": {
				await this.opts.projectStore.permanentlyDeleteSessions(event.sessionIds);
				reply({ type: "trash:op", success: true });
				break;
			}
			case "trash:empty": {
				const deleted = await this.opts.projectStore.emptyTrash();
				reply({ type: "trash:op", success: true, deleted });
				break;
			}
			case "session:asks": {
				// ask_user_question double check：返回该 session 当前真实 pending 的
				// toolCallId 列表。前端用它核对本地消息派生的 ask 卡片是否仍有效。
				reply({
					type: "session:asks",
					sessionId: event.sessionId,
					pending: askRegistry.pendingToolCallIds(event.sessionId),
				});
				break;
			}
			case "session:messages": {
				const { sessions } = await this.opts.projectStore.load();
				const session = sessions.find((s) => s.id === event.sessionId);
				// isActive 供前端恢复/保留会话状态：仅当会话真正在处理中
				// （handle.busy）或冷启动中且有 prompt 排队（agent:prompt 的
				// _promptLocks 命中）才为 true。冷启动但无 prompt（getCommands /
				// prewarm 预热，打开历史会话仅查看）不视为 busy——否则前端
				// setActiveStatus(true) 会把 idle 历史会话误标 thinking，且冷启动
				// 完成后无 agent 事件复位，列表项一直转圈（回归自 da7acb15）。
				const isActive = this.opts.agentManager.isSessionActive(
					event.sessionId,
					this._promptLocks.has(event.sessionId),
				);
				const thinkingSince = this.opts.agentManager.getThinkingSince(
					event.sessionId,
				);
				// 已软删除的会话只读模式：不 touch、不 prewarm（仅做只读 jsonl 读取）
				const isDeleted = !!session?.deletedAt;
				// 定时任务执行存档同样只读回放：不 touch（不刷 lastActivity 排序）、
				// 不 prewarm（详情页纯回放，不拉起 pi 进程白占空闲回收周期）
				const isScheduler = session?.source === "scheduler";
				// 打开会话查看消息视为活跃：同步刷新磁盘 lastActivity（保持会话列表排序反映最近查看，
				// 并与 AgentManager 内存 lastActiveAt 一致）。fire-and-forget，不阻塞历史读取。
				// 但已软删除的会话不 touch——避免从回收站查看时刷新 lastActivity 导致排序异常。
				if (session && !isDeleted && !isScheduler) {
					void this.opts.projectStore.touchSession(event.sessionId).catch(() => {});
				}
				if (!session) {
					reply({
						type: "session:messages",
						sessionId: event.sessionId,
						messages: [],
						isActive,
						thinkingSince,
					});
					break;
				}
				// 后台预热 pi 进程（点开会话即激活）。冷启动完成后广播 session:activated——
				// 官方 get_session_stats 自此可用，前端收听后重拉 /stats 补齐 contextUsage
				// （否则占比胶囊要等下一回合 message_end 才出现）。热会话不广播（stats 本就可查）。
				const prewarm = () => {
					// 已软删除的会话不启动 pi 进程（只读查看模式）
					if (isDeleted) return;
					// 定时任务执行存档：只读查看不启动 pi 进程
					if (isScheduler) return;
					const cold = !this.opts.agentManager.isSessionAlive(session.id);
					void this.opts.agentManager
						.ensureStarted(session.projectId, session.primaryAgent, session.id)
						.then(() => {
							if (cold) {
								this.broadcast({
									type: "session:activated",
									sessionId: session.id,
								});
							}
						})
						.catch((err) => {
							// dispose 竞态（session:delete / 空闲回收与预热并发）导致 ensureStarted
							// 抛「会话已清理」是预期控制流，静默不打印；其他启动失败仍打 error。
							if ((err as Error & { code?: string })?.code === "SESSION_DISPOSED")
								return;
							console.error(
								`[ws-server] 后台预热会话进程失败 ${event.sessionId}:`,
								err,
							);
						});
				};
				if (session.piSessionFile) {
					try {
						const history = await readSessionHistory(session.piSessionFile, {
							isSessionActive: isActive,
						});
						const messages = history.map((m) => ({
							message: m,
							agentName: session.primaryAgent,
						}));
						reply({
							type: "session:messages",
							sessionId: event.sessionId,
							messages,
							isActive,
							thinkingSince,
						});
						prewarm();
						break;
					} catch (err) {
						if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
							reply({
								type: "session:messages",
								sessionId: event.sessionId,
								messages: [],
								isActive,
								thinkingSince,
							});
							prewarm();
							break;
						}
						console.warn(
							`[ws-server] 会话文件直读失败，回退进程路径 ${event.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				try {
					const sdkSession = await this.opts.agentManager.ensureStarted(
						session.projectId,
						session.primaryAgent,
						session.id,
					);
					const messages = (sdkSession.messages as any[]).map((m) => ({
						message: m,
						agentName: session.primaryAgent,
					}));
					reply({
						type: "session:messages",
						sessionId: event.sessionId,
						messages,
						isActive,
						thinkingSince,
					});
				} catch {
					reply({
						type: "session:messages",
						sessionId: event.sessionId,
						messages: [],
						isActive,
						thinkingSince,
					});
				}
				break;
			}
			case "session:stats": {
				// 主/子拆分统一来源：jsonl 全量扫描（assistant+compaction→主，
				// toolResult.usage→子代理）。delegate/fleet 的 toolResult 携带 usage 后，
				// pi 官方 stats 的 tokens 已原生含子代理消耗，官方路径只需补拆分。
				const { sessions } = await this.opts.projectStore.load();
				const session = sessions.find((s) => s.id === event.sessionId);
				const split = session?.piSessionFile
					? await computeSessionUsage(session.piSessionFile).catch(() => null)
					: null;
				// 1) 官方 stats：进程存活时直接拿 pi get_session_stats（累计含子代理 + 当前上下文占用）
				const official = await this.opts.agentManager.getSessionStats(
					event.sessionId,
				);
				if (official?.tokens) {
					reply({
						type: "session:stats",
						sessionId: event.sessionId,
						stats: {
							tokens: splitOfficialTokens(
								toTokenSummary(official.tokens),
								split?.subagent,
							),
							contextUsage: normalizeContextUsage(official.contextUsage),
						},
					});
					break;
				}
				// 2) 本地降级：jsonl 扫描拆分直接给出主/子（含压缩前历史 + 缓存），无 contextUsage
				if (split) {
					reply({
						type: "session:stats",
						sessionId: event.sessionId,
						stats: { tokens: mergeTokenUsage(split.main, split.subagent) },
					});
					break;
				}
				reply({
					type: "session:stats",
					sessionId: event.sessionId,
					stats: null,
				});
				break;
			}
			case "agent:prompt": {
				// 用前端传的 sessionId 查找已有 session；找不到则用该 id 创建，确保前后端一致
				// session 级串行锁：仅覆盖 ensureStarted（建会话/加载扩展等），不覆盖 am.prompt()。
				// 若把 prompt 也锁在内，空闲时 session.prompt() 会 await 整个 agent turn，导致后续
				// 排队消息等到 turn 完全结束才执行——此时 isStreaming=false 误走直发而非 followUp
				// 入队，与 steer:promote 配合导致消息重复发送（session s-e34af47e 日志确证）。
				const prevLock =
					this._promptLocks.get(event.sessionId) ?? Promise.resolve();
				const myVersion = this._abortVersions.get(event.sessionId) ?? 0;
				let promptReady = false; // 锁内置位：ensureStarted 成功且版本匹配，允许锁外发 prompt
				const currentLock = prevLock
					.then(async () => {
						const { sessions } = await this.opts.projectStore.load();
						const existing = sessions.find((s) => s.id === event.sessionId);
						// 存量会话的 primaryAgent 配置已删除 → 拦截，不进入 ensureStarted
						if (
							existing &&
							!(await this.opts.configStore.getAgent(existing.primaryAgent))
						) {
							// 同时广播：REST 下 reply 只进 HTTP 400 响应体，不上 SSE 总线，
							// 前端重选弹窗（AgentMissingModal）监听的是事件流里的 error 事件
							this.broadcast({
								type: "error",
								message: "agent_missing",
								sessionId: event.sessionId,
							});
							reply({
								type: "error",
								message: "agent_missing",
								sessionId: event.sessionId,
							});
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
								reply({
									type: "error",
									message: `默认工作区会话目录创建失败: ${(e as Error).message}`,
									sessionId: event.sessionId,
								});
								return;
							}
						}
						const session =
							existing ??
							(await this.opts.projectStore.createSession({
								projectId: event.projectId,
								primaryAgent: event.agentName,
								title: event.text.slice(0, 20),
								id: event.sessionId,
								createdAt,
							}));
						if (isNew) {
							this.broadcast({ type: "session:created", session });
						} else {
							// 已有会话但 primaryAgent 与本次发送不一致（新建页挂载时 getCommands
							// 兜底可能已用默认 agent 建过会话）：同步记录，避免侧栏/重开后显示旧 agent
							const agentChanged = session.primaryAgent !== event.agentName;
							if (agentChanged) {
								await this.opts.projectStore.setSessionAgent(
									session.id,
									event.agentName,
								);
							}
							// 已有会话但标题为空（如 getCommands 兜底创建的会话）：
							// 首次发送消息时用消息内容自动命名，刷新侧栏标题
							const filled = await this.opts.projectStore.fillSessionTitleIfEmpty(
								session.id,
								event.text.slice(0, 20),
							);
							if (agentChanged || filled) {
								await this.broadcastProjectsList();
							}
						}
						// slash 文本延迟回显：pi 对已注册的扩展命令直接执行 handler（拦截），
						// 不写 transcript、不发 user message 事件——若照常回显，聊天窗会
						// 多出一条并不存在的用户消息。需等 ensureStarted 后查命令清单再定。
						const deferEcho = event.text.startsWith("/");
						if (!deferEcho) {
							reply({
								type: "session:echo_user",
								sessionId: session.id,
								text: event.text,
								agentName: event.agentName,
							});
						}
						await this.opts.projectStore.touchSession(session.id);
						try {
							await this.opts.agentManager.ensureStarted(
								event.projectId,
								event.agentName,
								session.id,
							);
							// ensureStarted 可能耗时 5-10s，期间可能收到 abort/clear，再次检查版本
							const curVersion = this._abortVersions.get(event.sessionId) ?? 0;
							if (curVersion !== myVersion) {
								return;
							}
							promptReady = true;
							if (deferEcho) {
								// 命中已注册扩展命令 → pi 直接消费、无用户消息，不回显；
								// 未注册 / prompt / skill 来源 → 会展开为用户消息发给 LLM，照常回显。
								// 查询失败时兜底回显（宁可多显示一条，不丢用户消息）。
								try {
									const cmdName = event.text.slice(1).split(/\s/, 1)[0];
									const commands = await this.opts.agentManager.getCommands(session.id);
									const hit = commands.find((c) => c.name === cmdName);
									if (hit?.source !== "extension") {
										reply({
											type: "session:echo_user",
											sessionId: session.id,
											text: event.text,
											agentName: event.agentName,
										});
									}
								} catch {
									reply({
										type: "session:echo_user",
										sessionId: session.id,
										text: event.text,
										agentName: event.agentName,
									});
								}
							}
						} catch (err) {
							this.broadcast({
								type: "error",
								message: `agent 启动失败: ${(err as Error).message}`,
								agentName: event.agentName,
								sessionId: session.id,
							});
						}
					})
					.finally(() => {
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
					this.opts.agentManager
						.prompt(event.sessionId, event.text, {
							model: event.model,
							thinking: event.thinking,
							attachments: event.attachments,
						})
						.catch((err) => {
							this.broadcast({
								type: "error",
								message: `agent 启动失败: ${(err as Error).message}`,
								agentName: event.agentName,
								sessionId: event.sessionId,
							});
						});
				}
				break;
			}
			case "agent:abort": {
				console.log(`[ws-server] agent:abort sessionId=${event.sessionId}`);
				this._abortVersions.set(
					event.sessionId,
					(this._abortVersions.get(event.sessionId) ?? 0) + 1,
				);
				const wasStreaming = this.opts.agentManager.isSessionStreaming(
					event.sessionId,
				);
				await this.opts.agentManager.abort(event.sessionId);
				if (!wasStreaming) {
					this._pendingAbortOnStart.add(event.sessionId);
					console.log(
						`[ws-server] PENDING abort on agent_start sessionId=${event.sessionId}`,
					);
				}
				console.log(`[ws-server] agent:abort DONE sessionId=${event.sessionId}`);
				break;
			}
			case "agent:answer": {
				// ask_user_question 应答：直达 AskRegistry.resolve（幂等）。
				// 未命中（stale ask：已取消/会话切换/重启残留）时 reply 错误，
				// 前端收到 400 才能恢复“提交中”状态并提示用户，否则永久卡住。
				const ok = askRegistry.resolve(
					event.sessionId,
					event.toolCallId,
					event.reply,
				);
				if (!ok) {
					reply({
						type: "error",
						message: "该提问已失效（可能已取消或会话已切换），请重新发起",
					});
				}
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
					this.broadcast({
						type: "error",
						message: `引导失败: ${(err as Error).message}`,
					});
					break;
				}
				// 注入成功：若会话标题为空则自动补全（与 agent:prompt 行为一致）
				await this.fillEmptySessionTitle(event.sessionId, event.text);
				break;
			}
			case "steer:immediate-message": {
				try {
					await this.opts.agentManager.abort(event.sessionId);
					await this.opts.agentManager.steerMessage(event.sessionId, event.text);
				} catch (err) {
					this.broadcast({
						type: "error",
						message: `立即执行失败: ${(err as Error).message}`,
					});
					break;
				}
				// 注入成功：若会话标题为空则自动补全（与 agent:prompt 行为一致）
				await this.fillEmptySessionTitle(event.sessionId, event.text);
				break;
			}
			case "clear-queue": {
				this.opts.agentManager.clearFollowUpList(event.sessionId);
				break;
			}

			case "agent:list": {
				reply({
					type: "agent:list",
					agents: await this.opts.configStore.listAgents(),
				});
				break;
			}
			case "agent:create": {
				try {
					const agent = await this.opts.configStore.createAgent(event.displayName);
					reply({ type: "agent:created", agent });
					this.broadcast({
						type: "agent:list",
						agents: await this.opts.configStore.listAgents(),
					});
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
				break;
			}
			case "agent:presets": {
				try {
					reply({ type: "agent:presets", presets: listPresets() });
				} catch (err) {
					console.error("[ws] agent:presets error:", err);
					reply({ type: "agent:presets", presets: [] });
				}
				break;
			}
			case "agent:preset:get": {
				// 单个预设完整内容（含 body 正文），供「查看提示词」按需获取
				const preset = getPreset(event.id);
				if (preset) {
					reply({ type: "agent:preset", preset });
				} else {
					reply({
						type: "error",
						message: `预设不存在: ${event.id}`,
						status: 404,
					});
				}
				break;
			}
			case "agent:create-from-preset": {
				const result = await createAgentFromPreset(
					this.opts.configStore,
					event.id,
					event.displayName,
				);
				if (result.ok) {
					reply({ type: "agent:created", agent: result.agent });
					this.broadcast({
						type: "agent:list",
						agents: await this.opts.configStore.listAgents(),
					});
				} else {
					reply({
						type: "error",
						message: result.error,
						status: result.status,
					});
				}
				break;
			}
			case "agent:delete": {
				try {
					// 删除前取渠道引用计数（渠道服务未启用则缺省）：随响应返回，便于调用方提示影响面
					const channelRefs = this.opts.channelManager
						? await this.opts.channelManager.agentUsage(event.name)
						: undefined;
					await this.opts.configStore.deleteAgent(event.name);
					reply({ type: "agent:deleted", name: event.name, channelRefs });
					this.broadcast({
						type: "agent:list",
						agents: await this.opts.configStore.listAgents(),
					});
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
				break;
			}
			case "agent:tools:list": {
				reply({
					type: "agent:tools:list",
					tools: await this.opts.agentManager.listGlobalTools(),
				});
				break;
			}
			case "agent:config:get": {
				const config =
					(await this.opts.configStore.getAgent(event.agentName)) ??
					makeDefaultAgentConfig(event.agentName);
				reply({ type: "agent:config", agentName: event.agentName, config }); // 定向
				break;
			}
			case "agent:config:save": {
				// 改名（agentName 为旧 displayName，config.displayName 为新值）：走 renameAgent 并联动会话与关系网
				if (event.agentName !== event.config.displayName) {
					const errs = await this.opts.configStore.renameAgent(
						event.agentName,
						event.config,
					);
					if (errs.length > 0) {
						reply({ type: "error", message: errs.join("；") });
						break;
					}
					// 联动：会话 primaryAgent 批量改
					const { sessions } = await this.opts.projectStore.load();
					for (const s of sessions.filter(
						(x) => x.primaryAgent === event.agentName,
					)) {
						await this.opts.projectStore.setSessionAgent(
							s.id,
							event.config.displayName,
						);
					}
					// 联动：其他 agent 的 partners.askTo 中旧名替换为新名
					for (const a of await this.opts.configStore.listAgents()) {
						if (
							a.displayName !== event.config.displayName &&
							a.partners.askTo.includes(event.agentName)
						) {
							a.partners.askTo = a.partners.askTo.map((n) =>
								n === event.agentName ? event.config.displayName : n,
							);
							await this.opts.configStore.saveAgent(a);
						}
					}
					this.opts.agentManager.renameAgentSessions(
						event.agentName,
						event.config.displayName,
					);
					await this.broadcastProjectsList();
					this.broadcast({
						type: "agent:list",
						agents: await this.opts.configStore.listAgents(),
					});
					break;
				}
				const errs = await this.opts.configStore.saveAgent(event.config);
				if (errs.length) {
					reply({ type: "error", message: errs.join("; ") });
					break;
				}
				this.broadcast({
					type: "agent:list",
					agents: await this.opts.configStore.listAgents(),
				});
				break;
			}
			case "subagent:list": {
				try {
					const { loadSubagentOverrides } = await import("./subagent-store");
					const { getSubagentInfo } = await import("./subagent-info");
					const { SUBAGENT_OVERRIDES_FILE } = await import("@wa-pi/shared");
					const overrides = await loadSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
					const subagents = await getSubagentInfo(overrides);
					reply({ type: "subagent:list", subagents });
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
				break;
			}
			case "subagent:save-override": {
				try {
					const { saveSubagentOverride, loadSubagentOverrides } = await import(
						"./subagent-store"
					);
					const { getSubagentInfo } = await import("./subagent-info");
					const { SUBAGENT_OVERRIDES_FILE } = await import("@wa-pi/shared");
					await saveSubagentOverride(SUBAGENT_OVERRIDES_FILE, event.override);
					const overrides = await loadSubagentOverrides(SUBAGENT_OVERRIDES_FILE);
					const subagents = await getSubagentInfo(overrides);
					// 保存后广播更新列表给所有前端
					reply({ type: "subagent:list", subagents });
				} catch (err) {
					reply({
						type: "error",
						message: err instanceof Error ? err.message : String(err),
					});
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
					for (let i = 67; i <= 90; i++) {
						// 'C'(67) 到 'Z'(90)
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
					const absPath = expandTilde(event.path);
					const dirents = await readdir(absPath, { withFileTypes: true });
					const entries: DirEntry[] = (
						await Promise.all(
							dirents.map(async (d) => {
								let isDir = d.isDirectory();
								if (d.isSymbolicLink()) {
									try {
										const s = await stat(join(absPath, d.name));
										isDir = s.isDirectory();
									} catch {
										isDir = false;
									}
								}
								return { name: d.name, isDir };
							}),
						)
					).filter((e) => event.showHidden || !e.name.startsWith("."));
					reply({ type: "fs:listDir", path: event.path, entries });
				} catch (e) {
					reply({
						type: "fs:error",
						path: event.path,
						reason: String(e instanceof Error ? e.message : e),
					});
				}
				break;
			}
			case "fs:readFile": {
				try {
					const absPath = expandTilde(event.path);
					const check = await checkPreviewable(absPath);
					if (!check.ok) {
						reply({
							type: "fs:unsupported",
							path: event.path,
							reason: check.reason,
						});
						break;
					}
					const buffer = await readFile(absPath);
					const content = buffer.toString("base64");
					const mimeType = getMimeType(event.path);
					reply({ type: "fs:readFile", path: event.path, content, mimeType });
				} catch (e) {
					const reason = String(e instanceof Error ? e.message : e);
					// ENOENT 回退：在最近存在祖先目录下递归搜索同名文件
					if (reason.includes("ENOENT")) {
						const resolved = expandTilde(event.path);
						const name = basename(resolved);
						let searchRoot = resolve(resolved, "..");
						while (searchRoot && !existsSync(searchRoot)) {
							const parent = resolve(searchRoot, "..");
							if (parent === searchRoot) {
								searchRoot = "";
								break;
							}
							searchRoot = parent;
						}
						if (searchRoot && name) {
							try {
								const found = await findFileByBasename(searchRoot, name);
								if (found) {
									const check2 = await checkPreviewable(found);
									if (!check2.ok) {
										reply({
											type: "fs:unsupported",
											path: found,
											reason: check2.reason,
										});
										break;
									}
									const buffer = await readFile(found);
									const content = buffer.toString("base64");
									const mimeType = getMimeType(found);
									reply({
										type: "fs:readFile",
										path: event.path,
										content,
										mimeType,
										resolvedPath: found,
									});
									break;
								}
							} catch {
								/* 搜索失败，回退到原始错误 */
							}
						}
					}
					reply({ type: "fs:error", path: event.path, reason });
				}
				break;
			}
			case "fs:upload": {
				try {
					const cwd = await resolveCwdForFsRequest(
						this.opts.projectStore,
						event.projectId,
						event.sessionId,
					);
					const buffer = Buffer.from(event.content, "base64");
					if (buffer.byteLength > MAX_UPLOAD_BYTES) {
						throw new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`);
					}
					const uploadDir = join(cwd, ".wa-pi", "uploads");
					await mkdir(uploadDir, { recursive: true });
					const filePath = await uniquePath(uploadDir, event.name);
					await writeFile(filePath, buffer);
					reply({ type: "fs:upload", id: event.id, path: filePath });
				} catch (e) {
					reply({
						type: "fs:upload",
						id: event.id,
						path: "",
						error: String(e instanceof Error ? e.message : e),
					});
				}
				break;
			}
			case "fs:copy": {
				try {
					const cwd = await resolveCwdForFsRequest(
						this.opts.projectStore,
						event.projectId,
						event.sessionId,
					);
					const expandedSource = expandTilde(event.source);
					const sourceStat = await stat(expandedSource);
					const isDir = sourceStat.isDirectory();

					if (isDir) {
						// 文件夹直接返回真实路径，不再创建软链接
						reply({ type: "fs:copy", id: event.id, path: event.source });
					} else {
						const uploadDir = join(cwd, ".wa-pi", "uploads");
						await mkdir(uploadDir, { recursive: true });
						const name = basename(event.source);
						const destPath = await uniquePath(uploadDir, name);
						await copyFile(expandedSource, destPath);
						reply({ type: "fs:copy", id: event.id, path: destPath });
					}
				} catch (e) {
					reply({
						type: "fs:copy",
						id: event.id,
						path: "",
						error: String(e instanceof Error ? e.message : e),
					});
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
						root,
						query,
						showHidden,
						maxResults,
						12,
						onlyDirs,
						onMatch,
						() => !activeSearches.has(requestId),
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
						reply({
							type: "fs:search",
							requestId,
							query,
							matches: [],
							durationMs: Date.now() - start,
							truncated: false,
						});
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
					const cwd = await resolveCwdForFsRequest(
						this.opts.projectStore,
						event.projectId,
						event.sessionId,
					);
					const uploadDir = join(cwd, ".wa-pi", "uploads");
					await appendChunk(uploadDir, event.recId, event.chunk);
					reply({ type: "fs:recording:append", id: event.id });
				} catch (e) {
					reply({
						type: "fs:recording:append",
						id: event.id,
						error: String(e instanceof Error ? e.message : e),
					});
				}
				break;
			}
			case "fs:recording:finalize": {
				try {
					const cwd = await resolveCwdForFsRequest(
						this.opts.projectStore,
						event.projectId,
						event.sessionId,
					);
					const uploadDir = join(cwd, ".wa-pi", "uploads");
					const path = await finalizeRecording(
						uploadDir,
						event.recId,
						event.finalName,
					);
					reply({ type: "fs:recording:finalize", id: event.id, path });
				} catch (e) {
					reply({
						type: "fs:recording:finalize",
						id: event.id,
						path: "",
						error: String(e instanceof Error ? e.message : e),
					});
				}
				break;
			}
			case "fs:recording:discard": {
				try {
					const cwd = await resolveCwdForFsRequest(
						this.opts.projectStore,
						event.projectId,
						event.sessionId,
					);
					const uploadDir = join(cwd, ".wa-pi", "uploads");
					await discardRecording(uploadDir, event.recId);
					reply({ type: "fs:recording:discard", id: event.id });
				} catch (e) {
					reply({
						type: "fs:recording:discard",
						id: event.id,
						error: String(e instanceof Error ? e.message : e),
					});
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
				await ensureProviderExtensionRegistered(
					this.opts.providerStore,
					this.opts.generatedDir,
				);
				// provider-extension.ts 已重写，但运行中的 pi session 进程仍加载旧版本，
				// 新增/删除的模型在旧 session 里会 "Model not found"。标脏让激活会话下次
				// 使用时重建进程、重新加载最新 extension（与 extension:toggle 等变更一致）。
				this.opts.agentManager.markAllDirty();
				const providers = await this.opts.providerStore.load();
				this.broadcast({ type: "provider:changed", providers });
				break;
			}
			case "provider:delete": {
				await this.opts.providerStore.delete(event.id);
				await ensureProviderExtensionRegistered(
					this.opts.providerStore,
					this.opts.generatedDir,
				);
				this.opts.agentManager.markAllDirty();
				const providers = await this.opts.providerStore.load();
				this.broadcast({ type: "provider:changed", providers });
				break;
			}
			case "provider:test": {
				// openai-completions 的 baseUrl 需要带 /v1（拼 /models），用内置目录的正确 baseUrl
				// 纠正 providers.json 里缺后缀的旧值；按 slug 过滤避免同名模型跨 provider 污染。
				// anthropic-messages 的 baseUrl 不带 /v1（testProviderConnection 自己拼 /v1/messages），不覆盖。
				let testBaseUrl = event.baseUrl;
				if (event.api === "openai-completions") {
					try {
						const allModels = await getAllCatalogModels();
						testBaseUrl = resolveProviderBaseUrl(
							event.slug,
							(event.models ?? []).map((m) => m.id),
							event.baseUrl,
							allModels,
						);
					} catch (err) {
						// 目录查询失败：回退用户配置的 baseUrl，不阻断测试
					}
				}
				const result = await testProviderConnection({
					baseUrl: testBaseUrl,
					apiKey: event.apiKey,
					api: event.api,
					models: event.models,
				});
				reply({ type: "provider:test", ok: result.ok, error: result.error });
				break;
			}
			case "settings:get": {
				const retry = await loadRetrySettings();
				const httpIdleTimeoutMs = await loadHttpIdleTimeoutMs();
				reply({ type: "settings:current", retry, httpIdleTimeoutMs });
				break;
			}
			case "settings:save": {
				try {
					const retry = await saveRetrySettings(event.retry);
					// httpIdleTimeoutMs 可选：缺省（undefined）不变更，null 恢复默认，数字则校验保存
					let httpIdleTimeoutMs = await loadHttpIdleTimeoutMs();
					if (event.httpIdleTimeoutMs !== undefined) {
						httpIdleTimeoutMs =
							event.httpIdleTimeoutMs === null
								? // 恢复默认必须落盘：只改局部变量的话重启后旧值复活
									await saveHttpIdleTimeoutMs(DEFAULT_HTTP_IDLE_TIMEOUT_MS)
								: await saveHttpIdleTimeoutMs(event.httpIdleTimeoutMs);
					}
					// 运行中的 pi 进程仍持启动时加载的旧 settings；标脏让会话下次
					// 使用时重建进程加载新配置（与 provider:save 一致）。
					this.opts.agentManager.markAllDirty();
					reply({ type: "settings:current", retry, httpIdleTimeoutMs });
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "model:presets": {
				try {
					// pi 内置模型目录（pi-catalog.ts，只读数据，不经 SDK）
					const all = await getAllCatalogModels();
					const map = new Map<string, any>();
					for (const m of all) {
						const k = m.provider;
						if (!map.has(k))
							map.set(k, {
								key: k,
								name: (await getProviderDisplayName(k)) || k,
								baseUrl: m.baseUrl || "",
								api: m.api || "openai-completions",
								models: [] as any[],
							});
						const e = map.get(k)!;
						if (!e.baseUrl && m.baseUrl) e.baseUrl = m.baseUrl;
						e.models.push({
							id: m.id,
							contextWindow: m.contextWindow,
							maxTokens: m.maxTokens,
							supportsVision: (m.input as string[])?.includes("image") ?? false,
						});
					}
					const presets = Array.from(map.values())
						.filter((p: any) => p.models.length > 0)
						.sort((a: any, b: any) => a.key.localeCompare(b.key));
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
					const skillResult = await this.scanSkillsWithExtensions();
					this.broadcast({ type: "skill:changed", ...skillResult });
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "extension:install": {
				// install:done / error / changed 必须显式走 SSE 广播：前端 installPackage 用
				// fire-and-forget 丢弃 HTTP 响应体，仅靠 SSE 事件翻转 installs 占位状态。
				// progress 类型含 "progress" 被 callApi 自动广播，reply 即可。
				try {
					const onProgress = (message: string) =>
						reply({ type: "extension:progress", name: event.name, message });
					await this.opts.extensionManager.install(event.name, onProgress);
					this.opts.agentManager.markAllDirty();
					const { packages } = await this.opts.extensionManager.list();
					this.broadcast({ type: "extension:changed", packages });
					// 成功终态：前端据此清除占位卡（真实卡片由上面的 changed 提供）
					this.broadcast({ type: "extension:install:done", name: event.name });
					const skillResult = await this.scanSkillsWithExtensions();
					this.broadcast({ type: "skill:changed", ...skillResult });
				} catch (err) {
					this.broadcast({
						type: "extension:error",
						name: event.name,
						error: (err as Error).message,
					});
				}
				break;
			}
			case "extension:uninstall": {
				try {
					await this.opts.extensionManager.uninstall(event.name);
					this.opts.agentManager.markAllDirty();
					const { packages } = await this.opts.extensionManager.list();
					this.broadcast({ type: "extension:changed", packages });
					const skillResult = await this.scanSkillsWithExtensions();
					this.broadcast({ type: "skill:changed", ...skillResult });
				} catch (err) {
					this.broadcast({
						type: "extension:error",
						name: event.name,
						error: (err as Error).message,
					});
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
					const skillResult = await this.scanSkillsWithExtensions();
					this.broadcast({ type: "skill:changed", ...skillResult });
				} catch (err) {
					this.broadcast({
						type: "extension:error",
						name: event.name,
						error: (err as Error).message,
					});
				}
				break;
			}
			case "extension:repair": {
				try {
					// 类型含 "progress" → callApi 自动 SSE 广播，reply 即可（与 install/upgrade 一致）
					const onProgress = (message: string) =>
						reply({ type: "extension:repair:progress", message });
					await this.opts.extensionManager.repair(onProgress);
					this.opts.agentManager.markAllDirty();
					const { packages } = await this.opts.extensionManager.list();
					this.broadcast({ type: "extension:changed", packages });
					this.broadcast({ type: "extension:repair:done" });
					const skillResult = await this.scanSkillsWithExtensions();
					this.broadcast({ type: "skill:changed", ...skillResult });
				} catch (err) {
					// name=repair 不匹配任何 installs/upgrading → 前端落全局 error 区
					this.broadcast({
						type: "extension:error",
						name: "repair",
						error: (err as Error).message,
					});
				}
				break;
			}
			case "extension:commands:list": {
				// 插件命令页无 session 上下文：传空 sessionId，getCommands 会借用任意
				// 活跃 pi 进程实时拉取命令（无活跃进程返回空数组，不创建孤儿进程）。
				// enabled 已由 AgentManager._fetchCommands 统一合并（对齐 session:commands 路径），
				// 这里不再二次合并，直接透传，避免双份合并逻辑漂移。
				try {
					const commands = await this.opts.agentManager.getCommands("");
					reply({ type: "extension:commands:list", commands });
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "extension:commands:toggle": {
				try {
					await this.opts.extensionManager.setCommandToggle(
						event.packageName,
						event.command,
						event.enabled,
					);
					reply({ type: "extension:commands:toggle", ok: true });
					// 广播命令变更事件：前端据此刷新 / 菜单命令列表（开启/关闭后立即生效）
					this.broadcast({ type: "extension:commands:changed" });
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "extension:dialog:respond": {
				// pi 扩展 dialog 应答：直达 ExtUiRegistry.respond（幂等；未知/已应答 id 报 400）
				const ok = extUiRegistry.respond(event.requestId, {
					value: event.value,
					confirmed: event.confirmed,
					cancelled: event.cancelled,
				});
				if (!ok) {
					reply({
						type: "error",
						message: "对话不存在或已应答",
						sessionId: event.sessionId,
					});
					break;
				}
				reply({ type: "extension:dialog:respond", ok: true });
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
					const instructions = await this.opts.memoryStore.listInstructions(
						event.projectId,
					);
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
					await this.opts.mcpStore.save(
						event.config,
						event.projectId,
						event.originalName,
					);
					const servers = await this.opts.mcpStore.list(event.projectId);
					this.broadcast({
						type: "mcp:changed",
						projectId: event.projectId,
						servers,
					});
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "mcp:delete": {
				try {
					await this.opts.mcpStore.delete(event.serverName, event.projectId);
					const servers = await this.opts.mcpStore.list(event.projectId);
					this.broadcast({
						type: "mcp:changed",
						projectId: event.projectId,
						servers,
					});
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "mcp:test": {
				// mcp:testResult 只走 SSE 广播（不 reply）：前端用 fire-and-forget 丢弃 HTTP 响应体，
				// 仅靠 SSE 事件翻转 testingServers。reply 会被 callApi 当作 HTTP 响应体返回，前端读不到。
				const emitTestResult = (payload: {
					success: boolean;
					status: McpServerStatus;
					toolCount?: number;
					error?: string;
				}) => {
					this.broadcast({
						type: "mcp:testResult",
						serverName: event.serverName,
						success: payload.success,
						status: payload.status,
						toolCount: payload.toolCount,
						error: payload.error,
					});
				};
				try {
					const config = await this.opts.mcpStore.getServer(
						event.serverName,
						event.projectId,
					);
					const cwd = await this.resolveProjectCwd(event.projectId);
					const outcome = await testConnection(config, cwd);
					emitTestResult({
						success: outcome.status === "connected",
						status: outcome.status,
						toolCount: outcome.toolCount,
						error: outcome.error,
					});
				} catch (err) {
					emitTestResult({
						success: false,
						status: "error",
						error: (err as Error).message,
					});
				}
				break;
			}
			case "mcp:listTools": {
				// 与 mcp:test 同理：mcp:tools 只走 SSE 广播，不 reply。
				// 前端 listTools 用 fire-and-forget 丢弃 HTTP 响应体，仅靠 SSE 事件填充 toolsCache。
				const emitToolsResult = (tools: McpToolSummary[] | { error: string }) => {
					this.broadcast({
						type: "mcp:tools",
						serverName: event.serverName,
						...(Array.isArray(tools) ? { tools } : tools),
					});
				};
				try {
					const config = await this.opts.mcpStore.getServer(
						event.serverName,
						event.projectId,
					);
					const cwd = await this.resolveProjectCwd(event.projectId);
					const tools = await listTools(config, cwd);
					emitToolsResult(tools);
				} catch (err) {
					emitToolsResult({ error: (err as Error).message });
				}
				break;
			}
			case "mcp:clearAuth": {
				// 与 mcp:test 同理：只走 SSE 广播，不 reply。
				const emitClearAuthResult = (payload: {
					success: boolean;
					status: McpServerStatus;
					error?: string;
				}) => {
					this.broadcast({
						type: "mcp:testResult",
						serverName: event.serverName,
						success: payload.success,
						status: payload.status,
						error: payload.error,
					});
				};
				try {
					await clearAuth(event.serverName);
					// 清除授权后：OAuth 服务器回到 needs_auth（可重新授权）；其它回到 disconnected
					const config = await this.opts.mcpStore
						.getServer(event.serverName, event.projectId)
						.catch(() => null);
					const status: McpServerStatus =
						config?.auth === "oauth" ? "needs_auth" : "disconnected";
					emitClearAuthResult({ success: true, status });
				} catch (err) {
					emitClearAuthResult({
						success: false,
						status: "error",
						error: (err as Error).message,
					});
				}
				break;
			}
			// ---------- IM 渠道机器人域（Task 7） ----------
			// channelManager 可空：未启用时列表类返回空，写操作不走（前端不暴露入口）。
			// create/update/delete 用 try/catch：ChannelManager 抛错 → reply error → callApi 映射 HTTP 400；
			// ChannelConflictError（Bot ID 冲突）额外携带 status:409 → callApi 映射 HTTP 409。
			case "channels:list": {
				const channels = this.opts.channelManager
					? await this.opts.channelManager.listWithStatus()
					: [];
				reply({ type: "channels:current", channels });
				break;
			}
			case "channels:create":
			case "channels:update":
			case "channels:delete": {
				try {
					const cm = this.opts.channelManager!;
					if (event.type === "channels:create") await cm.create(event.channel);
					else if (event.type === "channels:update")
						await cm.update(event.id, event.channel);
					else await cm.remove(event.id);
					reply({
						type: "channels:current",
						channels: await cm.listWithStatus(),
					});
				} catch (err) {
					reply({
						type: "error",
						message: (err as Error).message,
						...(err instanceof ChannelConflictError ? { status: 409 } : {}),
					});
				}
				break;
			}
			case "channels:agent-usage": {
				const usage = await this.opts.channelManager!.agentUsage(event.agentName);
				reply({
					type: "channels:agent-usage-result",
					agentName: event.agentName,
					...usage,
				});
				break;
			}
			case "channel-conversations:list": {
				const conversations = this.opts.channelManager
					? await this.opts.channelManager.listConversations()
					: [];
				reply({ type: "channel-conversations:current", conversations });
				break;
			}
			case "contacts:list": {
				const contacts = this.opts.channelManager
					? await this.opts.channelManager.listContacts(event.channelId || undefined)
					: [];
				reply({ type: "contacts:current", contacts });
				break;
			}
			case "contacts:rename": {
				if (!this.opts.channelManager) {
					reply({ type: "error", message: "通讯录未启用", status: 400 });
					break;
				}
				try {
					const c = await this.opts.channelManager.renameContact(
						event.id,
						event.remark,
					);
					if (!c) {
						reply({ type: "error", message: "联系人不存在", status: 404 });
						break;
					}
					this.broadcast({ type: "contacts:changed" });
					reply({
						type: "contacts:current",
						contacts: await this.opts.channelManager.listContacts(),
					});
				} catch (err) {
					reply({
						type: "error",
						message: (err as Error).message,
						status: 500,
					});
				}
				break;
			}
			case "contacts:ensure": {
				if (!this.opts.channelManager) {
					reply({ type: "error", message: "通讯录未启用", status: 400 });
					break;
				}
				try {
					const c = await this.opts.channelManager.ensureContact(
						event.kind === "person"
							? { channelId: event.channelId, kind: "person", userId: event.userId! }
							: { channelId: event.channelId, kind: "group", chatId: event.chatId! },
					);
					reply({ type: "contacts:ensured", contact: c });
				} catch (err) {
					reply({
						type: "error",
						message: (err as Error).message,
						status: 500,
					});
				}
				break;
			}
			// mock 端点（测试专用，事件类型未进 WSClientEvent 联合，用 as any 兜底）
			case "channels:mock-inbound" as any: {
				this.opts.channelManager?.mockInbound(
					(event as any).id,
					(event as any).chatId,
					(event as any).text,
					{
						fromUserId: (event as any).fromUserId,
						chatType: (event as any).chatType,
					},
				);
				reply({ type: "ok" } as any);
				break;
			}
			case "channels:mock-outbox" as any: {
				const messages =
					this.opts.channelManager?.mockOutbox((event as any).id) ?? [];
				reply({ type: "ok", messages } as any);
				break;
			}
		}
	}

	/**
	 * 引导（steer）注入消息成功后，若会话标题为空则用消息前 20 字补全并广播 projects:list，
	 * 与 agent:prompt 的 fillSessionTitleIfEmpty 行为一致。补全失败不影响注入主流程。
	 */
	private async fillEmptySessionTitle(
		sessionId: string,
		text: string,
	): Promise<void> {
		try {
			const filled = await this.opts.projectStore.fillSessionTitleIfEmpty(
				sessionId,
				text.slice(0, 20),
			);
			if (filled) {
				await this.broadcastProjectsList();
			}
		} catch (err) {
			console.error(`[ws-server] 引导后自动补全标题失败 ${sessionId}:`, err);
		}
	}

	/** 解析项目工作目录；无 projectId（全局作用域）返回 undefined */
	private async resolveProjectCwd(
		projectId?: string,
	): Promise<string | undefined> {
		if (!projectId) return undefined;
		const { projects } = await this.opts.projectStore.load();
		return projects.find((p) => p.id === projectId)?.cwd;
	}
}
