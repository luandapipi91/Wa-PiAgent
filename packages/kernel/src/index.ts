import { ConfigStore } from "./config-store";
import { ProjectStore } from "./project-store";
import { ProviderStore } from "./provider-store";
import { AgentManager } from "./agent-manager";
import { WSServer } from "./ws-server";
import { SkillManager } from "./skill-manager";
import { ExtensionManager } from "./extension-manager";
import { MemoryStore } from "./memory-store";
import { McpStore } from "./mcp-store";
import { migrateLegacySessions } from "./migrate";
import { ensureProviderExtensionRegistered } from "./provider-extension";
import { ensureBridgeExtension } from "./bridge-extension";
import { ensureSystemProject } from "./ensure-system-project";
import { cleanupExpiredWorkdirs } from "./workdir-cleaner";
import { ensurePromptsConfig } from "./system-prompt";
import { ensureSubagentOverrides } from "./subagent-store";
import {
	loadTrashSettings,
	ensureHttpIdleTimeout,
	applySystemProxy,
} from "./settings-store";
import { classifySdkError } from "./sdk-errors";
import { SdkEventThrottle, SubagentProgressThrottle } from "./event-throttle";
import { cleanupRecordingTemp } from "./recording-store";
import { createCrashLogger, installCrashHandlers } from "./crash-logger";
import { ChannelManager } from "./channel-manager";
import { WecomAdapter } from "./channels/wecom-adapter";
import { MockAdapter } from "./channels/mock-adapter";
import { TaskScheduler, resolveTaskModel } from "./scheduler";
import {
	appendExecutionRecord,
	updateExecutionRecord,
} from "./scheduler-store";
import { parseImPushMentions, createImPushTool } from "./tools/robot-push";
import type { ImPushInjection } from "./agent-manager";
import { expandSkillTokens } from "./channels/skill-expand";
import {
	WS_PORT,
	WA_PI_DIR,
	BUILTIN_SKILLS_DIR,
	SYSTEM_PROJECT_CWD,
	SYSTEM_PROJECT_ID,
	PROMPTS_FILE,
	SUBAGENT_OVERRIDES_FILE,
	SCHEDULED_TASKS_FILE,
	EXECUTION_RECORDS_FILE,
} from "@wa-pi/shared";
import type { ExecutionRecord, ScheduledTask, PushResult } from "@wa-pi/shared";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WSServerEvent } from "@wa-pi/shared";

/**
 * 启动时确保 web-search.json 的 provider/workflow 为默认值（不弹 curator）。
 * 只合并覆盖这两个键，保留用户手动配置的其他字段（如各 provider 的 API key）。
 */
async function ensureWebSearchConfig(waPiDir: string): Promise<void> {
	const configPath = join(waPiDir, "web-search.json");
	// 默认 anysearch：匿名可用、无需 API key，开箱即用；
	// 用户如需其他 provider，显式配置 provider 字段即可（不会被覆盖）。
	const defaults = { provider: "anysearch", workflow: "auto-summary" };
	try {
		await mkdir(waPiDir, { recursive: true });
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(await readFile(configPath, "utf8"));
		} catch {
			/* 文件不存在或损坏 → 用默认值 */
		}
		const config = { ...existing, ...defaults };
		await writeFile(configPath, JSON.stringify(config) + "\n", "utf8");
	} catch {
		/* 静默忽略 */
	}
}

export async function startKernel(opts?: {
	staticDir?: string;
	port?: number;
}): Promise<{ port: number; stop: () => Promise<void> }> {
	// 让 pi 生态（pi-mcp-adapter 的 mcp-auth 等深导入模块）在本进程内解析到
	// ~/.pi/agent 作为 agent 目录；RPC 模式下 pi 子进程的环境变量由
	// AgentManager 在 spawn 时逐个注入（PI_CODING_AGENT_DIR=WA_PI_DIR），
	// 这里保留进程级设置供 kernel 内部的 pi 扩展包代码使用。
	process.env.PI_CODING_AGENT_DIR = WA_PI_DIR;

	// 启用 pi 0.84.2+ 的实验性严格 JSON-schema 约束采样
	// （对内置 read/bash/edit/write 工具的输出做约束解码，提升工具调用稳定性）。
	// 经 rpc-client 的 process.env 展开，自动覆盖主会话与子代理 spawn 的 pi 进程。
	process.env.PI_EXPERIMENTAL = "1";

	// 全局异常兜底（尽早注册）：任何未捕获异常/unhandledRejection 写入崩溃日志 +
	// 广播 error 给前端，绝不退出进程。bun 默认对未捕获 rejection 终止进程，
	// 历史中曾因此杀死 kernel（发消息回复部分内容后 SSE 断开，日志仅 code=null 无堆栈）。
	// broadcast 在下方 server 就绪后赋值（此前为 null，仅写日志）。
	let crashBroadcast: ((e: { type: "error"; message: string }) => void) | null =
		null;
	const crashLogger = createCrashLogger(
		join(WA_PI_DIR, "logs", "kernel-crash.log"),
	);
	installCrashHandlers(process, crashLogger, (e) => crashBroadcast?.(e));

	// 确保内置技能目录存在
	await mkdir(BUILTIN_SKILLS_DIR, { recursive: true });
	// 确保 sessions 目录存在（Pi SDK SessionManager.open 需要）
	await mkdir(`${WA_PI_DIR}/sessions`, { recursive: true });

	const configStore = new ConfigStore();
	const projectStore = new ProjectStore();
	const providerStore = new ProviderStore();
	const skillManager = new SkillManager(WA_PI_DIR);
	const extensionManager = new ExtensionManager(WA_PI_DIR);
	const memoryStore = new MemoryStore({ waPiDir: WA_PI_DIR, projectStore });
	const mcpStore = new McpStore({ waPiDir: WA_PI_DIR, projectStore });

	// 启动时把已有 providers 注册成 Pi extension（幂等）
	await ensureProviderExtensionRegistered(providerStore);

	// 启动时生成 bridge 扩展（幂等）：RPC 模式下 pi 子进程经它注册宿主工具并回调 /bridge/tool
	await ensureBridgeExtension();

	// 迁移旧版 agent 数据（含 name 字段、文件名用内部 name）到 displayName 作 id（幂等）
	const nameMapping = await configStore.migrateNameToDisplayName();
	if (nameMapping.size > 0) {
		const { sessions } = await projectStore.load();
		for (const s of sessions) {
			const newName = nameMapping.get(s.primaryAgent);
			if (newName) await projectStore.setSessionAgent(s.id, newName);
		}
		console.log(
			`[kernel] 已迁移 ${nameMapping.size} 个智能体 name → displayName`,
		);
	}

	// 逐角色检查、缺失才写入的幂等 seed（存量环境自动补齐新角色，不覆盖已有同名文件）
	await configStore.seedDefaults();

	const migrated = await migrateLegacySessions(projectStore);
	if (migrated) console.log("[kernel] 已迁移老数据至默认项目");

	// 启动时 seed 默认工作区虚拟项目（幂等）+ 确保 workdir 根目录存在
	await ensureSystemProject(projectStore);
	console.log(`[kernel] 默认工作区已就绪: ${SYSTEM_PROJECT_CWD}`);

	await ensureWebSearchConfig(WA_PI_DIR);

	// httpIdleTimeoutMs 默认值落盘：pi 缺省回退官方 300s，断网反馈慢 2.5 倍
	await ensureHttpIdleTimeout();

	// 应用已保存的系统代理（useSystemProxy + httpProxy）到进程环境变量
	await applySystemProxy();

	// 启动时确保 prompts.json 配置存在（幂等），用户可手动编辑调整段落顺序/内容
	await ensurePromptsConfig(PROMPTS_FILE);

	// 启动时确保 subagent-overrides.json 存在（幂等初始化空配置）
	await ensureSubagentOverrides(SUBAGENT_OVERRIDES_FILE);

	// 启动时清理过期 workdir 子目录（默认工作区会话被删后保留 7 天）
	try {
		const cleaned = await cleanupExpiredWorkdirs(projectStore);
		if (cleaned > 0)
			console.log(`[kernel] 已清理 ${cleaned} 个过期 workdir 子目录`);
	} catch (e) {
		console.warn("[kernel] workdir 清理失败:", e);
	}
	// 每天定时清理一次
	const DAY_MS = 24 * 60 * 60 * 1000;
	setInterval(() => {
		cleanupExpiredWorkdirs(projectStore).catch((e) => {
			console.warn("[kernel] workdir 定时清理失败:", e);
		});
	}, DAY_MS);

	// 启动清理：上次崩溃/异常退出遗留的录音临时分片
	try {
		const { projects } = await projectStore.load();
		await Promise.allSettled(
			projects.map((p) =>
				p.cwd
					? cleanupRecordingTemp(join(p.cwd, ".wa-pi", "uploads"))
					: Promise.resolve(),
			),
		);
	} catch (e) {
		console.warn("[kernel] 清理录音临时文件失败:", e);
	}

	// 用占位 agentManager 先建 server（解决循环依赖：onEvent 要用 server.broadcast）
	// broadcast 在 ws-server.ts 已改为 public，AgentManager.onEvent 可直接调
	let broadcast: (e: WSServerEvent) => void = () => {};
	const server = new WSServer({
		configStore,
		projectStore,
		providerStore,
		skillManager,
		extensionManager,
		memoryStore,
		mcpStore,
		dataDir: WA_PI_DIR,
		agentManager: null as any, // 占位，下面赋值
		channelManager: null, // Task 8 注入真实 ChannelManager 实例
		port: opts?.port ?? WS_PORT,
		...(opts?.staticDir ? { staticDir: opts.staticDir } : {}),
	});
	broadcast = (e) => server.broadcast(e);
	// server 就绪：让全局 crash handler 也能广播 error 给前端
	crashBroadcast = broadcast;

	// AgentManager.onEvent 直接广播 sdk:event
	// pi RPC 事件与 shared SDKEvent 结构兼容但 TS 判为不同类型，event 用 any 桥接
	// 0.84 起 message_update 只携带 delta 增量（无 partial 快照）：SdkEventThrottle
	// 不再节流合并（丢帧=丢字），全部事件原样透传、顺序不变；渲染合帧由前端承担。
	const eventThrottle = new SdkEventThrottle((e) => broadcast(e));
	// subagent:progress 经 SubagentProgressThrottle 窗口合并（delegate/fleet 每 token
	// 一帧 SSE → 前端卡片每帧重渲染的卡顿修复），终态立即透传不延迟。
	const subagentProgressThrottle = new SubagentProgressThrottle(
		(sessionId, toolCallId, event) =>
			broadcast({
				type: "subagent:progress",
				sessionId,
				toolCallId,
				progress: event,
			}),
	);
	// 前向声明：onEvent 闭包内引用 channelManager，但其值在下方 AgentManager 构造后才赋。
	// 闭包仅在运行期（首条事件到达时）解析，此时 const 已初始化，故安全；TS 需显式声明以通过。
	let channelManager: ChannelManager;
	const agentManager = new AgentManager({
		projectStore,
		configStore,
		providerStore,
		skillManager,
		extensionManager,
		memoryStore,
		mcpStore,
		// bridge 回调地址惰性取值：WS 端口在 server.start() 后才确定（AgentManager 构造在前）
		bridgeBaseUrl: () => `http://127.0.0.1:${server.actualPort}`,
		onEvent: (sessionId, projectId, agentName, event) => {
			// 诊断：记录工具执行事件（崩溃定位——看崩溃前最后执行的工具/事件）
			const et = (event as any)?.type;
			if (et === "tool_execution_start" || et === "tool_execution_end") {
				console.log(
					`[kernel] sdk ${et}: ${(event as any)?.toolName} sid=${sessionId}`,
				);
			}
			// 渠道回复出口：agent_settled 时按 replyGranularity 组装 IM 回复。
			// 必须在 throttle 之前——agent_settled 不可被节流丢弃（否则渠道收不到回复）。
			channelManager.onSessionEvent(sessionId, event as any);
			eventThrottle.handle({
				type: "sdk:event",
				projectId,
				sessionId,
				agentName,
				event: event as any,
			});
			// pi 运行时错误（不可用模型 / 鉴权失败 / 网络等）不抛异常，而是编码进
			// message_end{stopReason:"error", errorMessage}。ws-server 的 try/catch 抓不到，
			// 前端又不读这些字段 → 静默。这里按错误分类翻译广播：
			//   - transient（网络/超时/限流）→ {type:"net:status"} 状态条提示，不进对话流
			//   - fatal（鉴权/配额/模型不可用）→ {type:"error"} 红色会话消息
			const classified = classifySdkError(event as any);
			if (classified) {
				if (classified.category === "transient") {
					broadcast({
						type: "net:status",
						status: "degraded",
						message: classified.message,
						agentName,
						sessionId,
					});
					// 标记 transient：agent_settled 时跳过 followUp/steer drain，
					// 避免网络不可用时自动发送排队消息再次失败；队列保留等用户重发。
					agentManager.markNetDegraded(sessionId, true);
				} else {
					broadcast({
						type: "error",
						message: classified.message,
						agentName,
						sessionId,
					});
				}
			}
			// agent 回复完成时更新 lastActivity，让会话列表的时间反映最新活动（而非仅用户发送时间）
			if ((event as any).type === "message_end") {
				projectStore.touchSession(sessionId).catch(() => {});
			}
		},
		// 孤儿会话回滚：删除记录后刷新前端会话列表（projects:list）
		onSessionRollback: () => {
			projectStore
				.load()
				.then((data) =>
					broadcast({
						type: "projects:list",
						projects: data.projects,
						sessions: data.sessions,
					}),
				)
				.catch(() => {});
		},
		// 子代理进度广播出口：spawn 闭包 onProgress → onSubagentProgress → 节流合并 → SSE subagent:progress → 前端卡片
		onSubagentProgress: (sessionId, toolCallId, event) => {
			subagentProgressThrottle.handle(sessionId, toolCallId, event);
		},
	});
	// 回填真实 agentManager（绕开 TS 的「构造时已确定」语义；opts 为 private 故用 any 桥接）
	(server as any).opts.agentManager = agentManager;

	// 渠道管理器：在 agentManager 之后构造（onEvent 闭包与 replyTurn 依赖它）。
	// adapterFactories 显式传入，避免 ChannelManager 构造函数的 mock 兜底重复注册。
	// WA_PI_CHANNELS_MOCK=1 时附带注册 mock 工厂，供 E2E 与开发注入测试消息。
	channelManager = new ChannelManager({
		configStore,
		projectStore,
		agentManager,
		skillManager, // 渠道提示词 $[技能名] token 内联展开用
		broadcast,
		adapterFactories: {
			wecom: (c) => new WecomAdapter(c),
			...(process.env.WA_PI_CHANNELS_MOCK === "1"
				? { mock: (c) => new MockAdapter(c) }
				: {}),
		},
	});
	(server as any).opts.channelManager = channelManager; // 与 agentManager 同模式回填

	// 主聊天 @im-push-to 推送注入工厂后绑定：AgentManager 构造时 channelManager 尚未存在，
	// 沿用 bridgeBaseUrl 的惰性模式，在 channelManager 就绪后注入（会话注册表见 agent-manager）。
	agentManager.setImPushFactory((contactIds) => {
		const imPushTool = createImPushTool({
			channelManager,
			contactIds,
			// 主聊天无任务结果收集（定时任务的 pushResults 只属于 executeTask），推送结果直接回给 agent
			onPushResult: () => {},
		});
		return {
			targets: contactIds,
			execute: (contact, message) => imPushTool.execute({ contact, message }),
		};
	});

	await server.start();
	console.log(`[kernel] HTTP 监听 http://127.0.0.1:${server.actualPort}`);

	// 启动全部 enabled 渠道（无渠道时 ChannelManager.start() 空转不报错）。
	// 放在 server.start() 之后：渠道进站会触发 ensureStarted/broadcast，HTTP 已就绪。
	await channelManager.start();

	// —— 定时任务调度器 ——
	// 在 agentManager/channelManager 就绪后创建：executeTask 闭包依赖它们。
	// scheduler 实例注入 ws-server 后，REST 路由的 onRunNow/onTaskChanged 回调生效。
	const scheduler = new TaskScheduler({
		tasksFile: SCHEDULED_TASKS_FILE,
		recordsFile: EXECUTION_RECORDS_FILE,
		dataDir: WA_PI_DIR,
		broadcast: (event) => broadcast(event as WSServerEvent),
		executeTask: async (task: ScheduledTask): Promise<ExecutionRecord> => {
			const record: ExecutionRecord = {
				id: randomUUID(),
				taskId: task.id,
				taskName: task.name,
				agentId: task.agentId,
				status: "running",
				startedAt: Date.now(),
			};
			await appendExecutionRecord(EXECUTION_RECORDS_FILE, record);
			broadcast({
				type: "scheduled-tasks:changed",
			} as WSServerEvent);

			const sessionId = `sched-${task.id}-${Date.now()}`;
			const projectId = task.projectId ?? SYSTEM_PROJECT_ID;

			try {
				// 1. 创建会话记录（默认工作区需先生成 workdir 子目录）
				let createdAt: number | undefined;
				if (projectId === SYSTEM_PROJECT_ID) {
					createdAt = Date.now();
					await mkdir(join(SYSTEM_PROJECT_CWD, String(createdAt)), {
						recursive: true,
					});
				}
				await projectStore.createSession({
					projectId,
					primaryAgent: task.agentId as any,
					title: `定时任务 · ${task.name}`,
					id: sessionId,
					createdAt,
					source: "scheduler", // 执行会话独立于侧栏列表，只在执行记录里查看
				});
				record.sessionId = sessionId;

				// 2. 解析 @im-push-to(ch_xxx,ct_xxx) 标记：非空时构造 im_push_to 工具注入该会话
				// （pi 进程内 bridge 扩展经 env 注册工具，execute 经 /bridge/tool 回调到
				// agentManager.handleTool → pushToContact 主动推送），推送结果回填执行记录。
				const contactIds = parseImPushMentions(task.prompt);
				const pushResults: PushResult[] = [];
				let imPush: ImPushInjection | undefined;
				if (contactIds.length > 0) {
					// targetName 用联系人 id 占位（联系人名需查通讯录；后续优化点，不影响推送本身）
					const imPushTool = createImPushTool({
						channelManager,
						contactIds,
						onPushResult: (r) => {
							pushResults.push({
								targetId: r.targetId,
								targetName: r.targetId,
								success: r.success,
								error: r.error,
							});
						},
					});
					imPush = {
						targets: contactIds,
						execute: (contact, message) => imPushTool.execute({ contact, message }),
					};
				}

				// 3. 启动 agent 进程（imPush 非空时注入推送工具）
				await agentManager.ensureStarted(
					projectId,
					task.agentId as any,
					sessionId,
					imPush ? { imPush } : undefined,
				);

				// 4. 解析任务模型：task.model 优先，缺省回退到第一个 provider 的第一个模型
				const providers = await providerStore.load();
				const model = resolveTaskModel(task.model, providers);
				record.model = model;

				// 5. 发送 prompt（任务指令 + 可选的 $[技能名] 技能标记）。
				// @im-push-to 推送引导不再拼进 prompt——已在 ensureStarted 时注入 system prompt
				// 的 im-push 段（buildImPushSystemPrompt，agent 系统提示词里明确标记语义与工具用法）。
				// 技能标记在 kernel 侧展开：SDK 只展开消息开头的 /skill:，定时任务的
				// $[技能名] 可在任意位置，复用渠道提示词的展开逻辑（未知技能保留原文）。
				let promptToSend = task.prompt;
				if (promptToSend.includes("$")) {
					const skills = await channelManager.loadSkillContents();
					promptToSend = expandSkillTokens(promptToSend, skills);
				}
				await agentManager.prompt(sessionId, promptToSend, { model });

				// 6. 等待 agent 执行完成（轮询 isSessionBusy，agent_settled 后 busy=false）
				const POLL_INTERVAL_MS = 500;
				const MAX_WAIT_MS = 30 * 60 * 1000; // 单次任务最长等待 30 分钟
				const deadline = Date.now() + MAX_WAIT_MS;
				while (agentManager.isSessionBusy(sessionId)) {
					if (Date.now() > deadline) {
						await agentManager.abort(sessionId).catch(() => {});
						throw new Error("任务执行超时（30 分钟）");
					}
					await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
				}

				// 7. 收集最后一条 assistant 消息作为摘要
				const messages = agentManager.getMessages(sessionId);
				const lastAssistant = [...messages]
					.reverse()
					.find((m: any) => m?.role === "assistant");
				record.status = "success";
				record.finishedAt = Date.now();
				record.durationMs = record.finishedAt - record.startedAt;
				if (lastAssistant) {
					const textBlocks = (lastAssistant as any).content?.filter(
						(c: any) => c.type === "text",
					);
					if (textBlocks?.length > 0) {
						record.summary = textBlocks
							.map((c: any) => c.text)
							.join("\n")
							.slice(0, 500);
					}
				}
				// 8. 推送结果回填执行记录（im_push_to 调用后由 onPushResult 收集）
				if (pushResults.length > 0) {
					record.pushResults = pushResults;
					console.log(
						`[scheduler] 任务 ${task.name} 推送结果: ${pushResults
							.map((p) => `${p.targetId}=${p.success ? "ok" : p.error}`)
							.join(", ")}`,
					);
				}
			} catch (err) {
				record.status = "failed";
				record.finishedAt = Date.now();
				record.durationMs = record.finishedAt - record.startedAt;
				record.error = err instanceof Error ? err.message : String(err);
			}

			// 更新执行记录（覆盖 running 态的初始记录）
			await updateExecutionRecord(EXECUTION_RECORDS_FILE, record);
			return record;
		},
	});
	server.setScheduler(scheduler);
	await scheduler.start();
	console.log("[kernel] 定时任务调度器已启动");

	// 空闲会话子进程回收：每 30s 扫描，回收 lastActivity 超过 1 分钟且非 busy 的会话进程。
	// dispose 只杀进程、保留会话记录与 jsonl 历史，用户再点开时冷启动恢复。
	const IDLE_REAP_INTERVAL_MS = 30 * 1000;
	const IDLE_REAP_THRESHOLD_MS = 60 * 1000;
	const reapTimer = setInterval(() => {
		agentManager
			.reapIdleSessions(IDLE_REAP_THRESHOLD_MS)
			.then((reaped) => {
				if (reaped.length > 0) {
					console.log(
						`[kernel] 回收 ${reaped.length} 个空闲会话进程: ${reaped.join(", ")}`,
					);
				}
			})
			.catch((e) => {
				console.warn("[kernel] 空闲会话回收失败:", e);
			});
	}, IDLE_REAP_INTERVAL_MS);

	// —— 会话自动归档调度器 ——
	// 每 6 小时检查一次：把超过 autoArchiveDays 未活动的会话软删除到回收站，
	// 可选永久清理超过 autoPurgeDays 的回收站会话。归档后刷新前端会话列表。
	// 必须在 server 就绪后启动：runAutoArchive 调用 server.broadcastProjectsList()。
	const ARCHIVE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
	async function runAutoArchive() {
		try {
			const settings = await loadTrashSettings();
			if (!settings.autoArchiveEnabled) return;

			const thresholdMs = settings.autoArchiveDays * DAY_MS;
			const archived = await projectStore.archiveStaleSessions(thresholdMs);
			if (archived.length > 0) {
				console.log(`[kernel] 自动归档了 ${archived.length} 个未活动会话到回收站`);
				await server.broadcastProjectsList();
			}

			// 可选：自动清理过期回收站会话（物理删除）
			if (settings.autoPurgeEnabled) {
				const purgeBefore = Date.now() - settings.autoPurgeDays * DAY_MS;
				const purged = await projectStore.purgeOldTrashSessions(purgeBefore);
				if (purged > 0) {
					console.log(`[kernel] 自动清理了 ${purged} 个过期回收站会话`);
				}
			}
		} catch (e) {
			console.warn("[kernel] 回收站自动归档失败:", e);
		}
	}
	// 启动时立即检查一次 + 定时执行
	void runAutoArchive();
	const archiveTimer = setInterval(
		() => void runAutoArchive(),
		ARCHIVE_CHECK_INTERVAL_MS,
	);

	// 优雅退出：RPC 架构下每个会话是一个 pi 子进程，kernel 退出时必须统一回收，
	// 避免孤儿进程滞留（SIGINT/SIGTERM 先 disposeAll 再停 server）。
	// 注意：pi 子进程在 stdin 关闭后也会自行退出（EOF 兜底），这里是主动加速回收。
	const shutdown = async (signal: string) => {
		console.log(`[kernel] ${signal} 收到，回收 pi 子进程并停止服务...`);
		clearInterval(reapTimer);
		clearInterval(archiveTimer); // 回收站自动归档
		eventThrottle.dispose();
		scheduler.stopAll(); // 停止全部 cron 调度（避免退出期再触发新执行）
		// 先断渠道长连接（避免关闭期收到新进站再触发 agent 调用），再回收 pi 子进程
		await channelManager.stop().catch(() => {});
		await agentManager.disposeAll().catch(() => {});
		await server.stop().catch(() => {});
		await crashLogger.flush().catch(() => {}); // 确保崩溃日志落盘
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	return { port: server.actualPort, stop: () => server.stop() };
}

if (import.meta.main) {
	startKernel().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
