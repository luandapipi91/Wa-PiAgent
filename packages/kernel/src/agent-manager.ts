// AgentManager：管 pi rpc 子进程会话
//
// 架构（RPC 迁移后）：
// - 每个 WaPi 会话对应一个 `pi --mode rpc` 子进程（rpc-client.ts 驱动），
//   不再 import @earendil-works/pi-coding-agent 的 SDK API。
// - 引导消息走 pi 原生 steer()（turn_end 后自动投递）。
// - 排队消息存 WaPi 本地 followUpList，agent_settled 时逐条 drain。
//   pi RPC 的 queue_update 事件直接透传给前端，kernel 不合成。
// - 宿主工具（ask/memory/delegate/fleet）经 wa-pi-bridge 扩展注册到 pi 进程，
//   工具 execute 回调 kernel /bridge/tool（bridge-registry.ts 注册的 ctx 执行）。
// - 系统提示词组合（composePrompt）结果写入临时文件，经 --system-prompt <file> 传入。
// - 工具放行：默认排除式（-xt subagent）；agent 配置显式 tools 时用 --tools 白名单
//   （config.tools ∪ MCP direct 工具名）。
//
// 依赖注入：
// - createClientFn 可选参数，缺省时用真实 RpcClient（测试注入假 client）
// - bridgeBaseUrl 惰性取值：kernel 启动时 WS 端口在 AgentManager 构造后才确定

import type {
	AgentName,
	AttachmentRef,
	ThinkingLevel,
	MemoryConfig,
	SkillInfo,
	CommandInfo,
	SubagentProgressEvent,
} from "@wa-pi/shared";
import {
	WA_PI_DIR,
	GENERATED_DIR,
	DEFAULT_AGENT_TOOLS,
	BUILTIN_SKILLS_DIR,
	resolveAgentTools,
	resolveSessionCwd,
	PROMPTS_FILE,
	PROVIDERS_FILE,
	SUBAGENT_TYPES,
	isSubagentType,
	SYSTEM_PROJECT_ID,
	SYSTEM_PROJECT_CWD,
	matchKernelCommand,
} from "@wa-pi/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type { ProviderStore } from "./provider-store";
import { join, extname } from "node:path";
import { logAgentCrash } from "./crash-logger";
import {
	mkdir,
	writeFile,
	rm,
	appendFile,
	readFile,
	stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildAdditionalExtensionPaths } from "./extensions";
import { attachPackageName, type RawCommandInfo } from "./tui-command-filter";
import { getGlobalMemoryStore, getProjectMemoryStore } from "./amaster-memory";
import { reconcileDanglingAsks } from "./ask-tool";
import {
	makeDelegateTool,
	makeFleetTool,
	buildDelegateRoster,
	makeSpawnFn,
} from "./delegate-tool";
import {
	ensureProviderExtensionRegistered,
	extensionCoversProvider,
	isProviderExtensionStale,
} from "./provider-extension";
import { SubagentTelemetry } from "./subagent-telemetry";
import {
	AUTO_COMPACT_USAGE_RATIO,
	shouldCompactBeforeSend,
} from "./auto-compact";
import type { WaPiSpawnConfig } from "./subagent-runner";
import { seedBuiltinAgents } from "./builtin-agents";
import { readBuiltinAgentPrompt } from "./subagent-info";
import { askRegistry } from "./ask-registry";
import { BrowserManager } from "./browser-manager";
import { handleBrowserTool } from "./browser-tools";
import type { SkillManager } from "./skill-manager";
import type { ExtensionManager } from "./extension-manager";
import type { McpStore } from "./mcp-store";
import { resolveMcpDirectToolNames } from "./mcp-connector";
import {
	registerBridgeSession,
	unregisterBridgeSession,
	getBridgeToken,
	makeDefaultBridgeContext,
	type BridgeSessionContext,
	type BridgeToolResult,
} from "./bridge-registry";
import {
	RpcClient,
	buildPiArgs,
	resolvePiCliPath,
	resolvePiRuntime,
	stripAnsi,
	type RpcClientOpts,
	type RpcEvent,
	type RpcUiRequest,
	type UiResponseFields,
} from "./rpc-client";
import { extUiRegistry } from "./ext-ui-registry";
import {
	composePrompt,
	loadPromptSegments,
	ensureImChannelSegment,
	ensureImPushSegment,
	ensureScheduledTasksSegment,
	buildScheduledTasksSystemPrompt,
	DEFAULT_PROMPT_SEGMENTS,
	DEFAULT_MEMORY_POLICY_PROMPT,
	COMPACT_MEMORY_POLICY_PROMPT,
	WA_PI_DEFAULT_BASE_PROMPT,
	type PromptSegment,
} from "./system-prompt";
import {
	buildImPushSystemPrompt,
	GENERIC_IM_PUSH_PROMPT,
} from "./tools/robot-push";

/** 可注入的 client 工厂（测试用假 client 替换；生产 new RpcClient） */
export type CreateClientFn = (opts: RpcClientOpts) => RpcClient;

/** 定时任务会话注入的 im_push_to 能力（ensureStarted 传入，经 bridge 分发执行）。
 *  targets：任务 prompt 中 @im-push-to 标记的联系人 id 列表（写入子进程 env 供扩展注册工具）；
 *  execute：kernel 侧推送实现（index.ts 用 createImPushTool 构造），返回结果文本。 */
export interface ImPushInjection {
	targets: string[];
	execute: (contact: string, message: string) => Promise<string>;
}

/** 上层事件回调携带的事件类型：pi RPC 事件 + kernel 合成的 queue_update */
export type AgentManagerEvent = RpcEvent;

export interface AgentManagerOpts {
	projectStore: ProjectStore;
	// configStore 可空：测试用 mock client 时不需要真实配置
	configStore: ConfigStore | null;
	// providerStore 可空：保留兼容（RPC 模式下模型能力查询走 pi 进程，暂未使用）
	providerStore?: ProviderStore;
	// 上层事件回调：携带 sessionId/projectId/agentName 上下文，转发 pi 事件与合成事件
	onEvent: (
		sessionId: string,
		projectId: string,
		agentName: AgentName,
		e: AgentManagerEvent,
	) => void;
	/** 子代理进度广播出口（index.ts 接到 server.broadcast → SSE → 前端 DelegateCard/FleetCard）。
	 *  由流式 bridge 的 onProgress 帧触发，携带 sessionId 与本次工具调用的 toolCallId。 */
	onSubagentProgress?: (
		sessionId: string,
		toolCallId: string,
		event: SubagentProgressEvent,
	) => void;
	// 孤儿会话回滚：进程退出时若该会话从未写过消息文件（piSessionFile 不存在），
	// 删除记录后通知上层广播 projects:list 刷新前端列表
	onSessionRollback?: (sessionId: string) => void;
	// skillManager 可空：生产注入真实 SkillManager，解析启用 skill 目录传给 --skill
	skillManager?: SkillManager;
	// extensionManager 可空：用于按已启用动态插件决定 -e 扩展路径与工具放行
	extensionManager?: ExtensionManager;
	// mcpStore 可空：受限 agent 的 --tools 白名单需要 MCP direct 工具名（kernel 侧计算）
	mcpStore?: McpStore;
	// 惰性取 bridge 回调地址（kernel WS 端口在 AgentManager 构造后才确定）
	bridgeBaseUrl?: () => string;
	/** 主聊天 im_push_to 全局执行器：调用时实时按联系人 id 走 channelManager 全局长连接推送。
	 *  channelManager 构造晚于 AgentManager（循环依赖），由 index.ts 经 setImPushExecutor 后绑定；
	 *  定时任务会话仍用 ensureStarted 的 imPush 注入（优先于本执行器）。 */
	imPushExecutor?: (contact: string, message: string) => Promise<string>;
	/** 主聊天 list_contacts 全局执行器：调用时实时按 channelId 走 channelManager 拉取联系人列表。
	 *  channelManager 构造晚于 AgentManager（循环依赖），由 index.ts 经 setListContactsExecutor 后绑定。 */
	listContactsExecutor?: (channelId?: string) => Promise<string>;
	// 测试注入 fake；生产不传 → 默认 new BrowserManager()。browser_* 工具的分派目标
	browserManager?: BrowserManager;
	// 测试注入 mock；生产留空 → 真实 RpcClient
	createClientFn?: CreateClientFn;
	// abort RPC 无响应的兜底超时（ms）：超时强杀 pi 进程，保证「停止」一定生效。
	// 默认 5000；测试注入小值。
	abortTimeoutMs?: number;
	// 记忆配置读取（reviewEnabled 自动学习开关 / memoryPolicyStyle 注入提示开关）。
	// 可空：测试场景不传视为全开（与历史行为一致）；生产注入 MemoryStore。
	memoryStore?: { getConfig(): Promise<MemoryConfig> };
}

// 系统提示词的默认兜底基础段（被 prompts.json 的 base.content 覆盖；
// 若 base.content 也未写、且 config.systemPromptBody 未指定，最终使用此值）。
// 完整提示词段落组装见 system-prompt.ts。
export const WA_PI_DEFAULT_SYSTEM_PROMPT = WA_PI_DEFAULT_BASE_PROMPT;

/** 永不放行给 LLM 直接调用的工具（subagent 必须走宿主 delegate 工具） */
const ALWAYS_EXCLUDED_TOOLS = ["subagent"];

/** 单个任务周期内崩溃自动接力上限：超过后回落为报错提示，不再自动续跑（用户拍板 2 次） */
const AUTO_RESUME_MAX_ATTEMPTS = 2;
/** 崩溃后延迟重建毫秒数：给进程退出/资源释放留缓冲 */
const AUTO_RESUME_DELAY_MS = 1_000;
/** 续跑触发消息前缀标记：LLM 可见、前端按此过滤不渲染（用户无感） */
export const AUTO_RESUME_MARKER = "[WAPI-AUTO-RESUME]";
/** 续跑触发指令：告知 agent 从中断处接续任务（隐藏于 UI） */
const AUTO_RESUME_PROMPT = `${AUTO_RESUME_MARKER} 你之前的运行因故障异常中断。请根据上方对话历史判断已完成进度，先检查可能写到一半的文件或操作，从中断处继续完成原任务，不要重复已完成的工作。`;

/** 单个会话的运行时句柄 */
interface SessionHandle {
	client: RpcClient;
	cwd: string;
	meta: { projectId: string; agentName: AgentName };
	/** agent 是否忙碌（prompt 发送后置 true，agent_settled 置 false） */
	busy: boolean;
	/** agent_start 的时间戳（ms），用于前端恢复思考计时 */
	thinkingSince: number | null;
	/** 本轮 user 消息落盘时刻（kernel 收到 user message_end 的 Date.now()，≈ jsonl 行级落盘） */
	turnUserAt: number | null;
	/** 历史消息快照（创建时经 get_messages 拉取 + message_end 增量追加） */
	messages: any[];
	/** 排队消息列表（agent_settled 时逐条 drain） */
	followUpList: Array<{ text: string; images?: ImageContent[] }>;
	/** 引导消息列表（优先级高于 followUpList，agent_settled 时优先 drain） */
	steerList: string[];
	/** 系统提示词临时文件（dispose 时清理） */
	promptFile: string | null;
	/** 记忆快照临时文件（dispose 时清理） */
	memorySnapshotFile: string | null;
	/** pi 会话文件路径：进程退出时据其是否存在判断是否孤儿（从未 prompt） */
	piSessionFile: string | null;
	/** 进程意外退出标记（下次 ensureStarted 重建） */
	crashed: boolean;
	/** dispose 标记（防止 onExit 误判为崩溃） */
	disposed: boolean;
	/** 子代理派发遥测收集器（会话销毁时 flush 到 subagent-telemetry.jsonl） */
	subagentTelemetry: SubagentTelemetry;
	/** 在跑子代理的中止控制器登记表（delegate/fleet 每次派发创建一个，完成移除）：
	 *  abort()/_teardownSession 级联触发，让子代理进程随主会话一起停止 */
	subagentAborts: Set<AbortController>;
	/** 主会话当前模型（"provider/modelId"）：子智能体「跟随主模型」时透传给 spawn --model */
	currentModel: string | null;
	/** 主会话当前 thinking level（prompt 时记录），子智能体「跟随主配置」时透传 */
	currentThinking: ThinkingLevel | null;
	/** transient 网络错误标记：true 时 agent_settled 跳过 followUp/steer drain，
	 *  避免网络不可用时自动发送排队消息（会再失败）。用户重发后清除。 */
	netDegraded: boolean;
	/** 崩溃自动接力计数（当前任务周期内）：用户主动发消息时清零（熔断参数） */
	autoResumeCount: number;
	/** 最近一次活跃时间戳（ms）：prompt / message_end / steer / 打开会话时刷新。
	 *  供 reapIdleSessions 判断是否回收该会话子进程，避免每轮读盘。 */
	lastActiveAt: number;
}

/** abort RPC 无响应的默认兜底超时（ms）：pi agent loop 卡死时强杀进程，保证停止生效 */
const ABORT_RPC_TIMEOUT_MS = 5_000;

export class AgentManager {
	// sessionId → SessionHandle（核心数据结构，一个 WaPi 会话对应一个 pi rpc 子进程）
	private sessions = new Map<string, SessionHandle>();
	// 并发创建锁：同 sessionId 同时只创建一次，防止快速连发导致重复初始化同一 jsonl
	private starting = new Map<string, Promise<SessionHandle>>();
	// 标记在创建过程中被 dispose 的 sessionId，防止已清理的会话在创建完成后重新泄漏回 Map
	private disposed = new Set<string>();
	// 标记在 _createSession 期间收到的 abort 请求：client 注册后立即执行
	private pendingAborts = new Set<string>();
	// deferred reload：技能/扩展配置变更后标脏；会话下次命中缓存时重建（pi 进程重启）
	private dirty = new Set<string>();
	// deferred 重建：skill 配置变更（目录增删 / skill 禁用）后标脏；与 dirty 统一为进程重启，
	// 保留两个集合仅为调用方语义区分（skill:toggle 走 markSkillsDirty，extension 走 markAllDirty）
	private skillDirty = new Set<string>();
	// 系统提示词段落配置缓存（首次加载后缓存；用户编辑 prompts.json 后需重启 kernel 刷新）
	private promptSegments: PromptSegment[] | null = null;
	// 会话级浏览器视图池：browser_* 工具的执行后端（可注入 fake，生产默认实例化）
	readonly browserManager: BrowserManager;

	constructor(private opts: AgentManagerOpts) {
		// 测试可注入 fake manager；生产默认创建真实 BrowserManager（延迟到首次工具调用才真正启动 WebView）
		this.browserManager = opts.browserManager ?? new BrowserManager();
	}

	/**
	 * 加载系统提示词段落配置（启动后首次调用时读 PROMPTS_FILE，之后用缓存）。
	 * 读失败或格式错误时降级用代码内置默认配置，绝不抛错（保证 agent 创建不被提示词文件阻塞）。
	 */
	private async getPromptSegments(): Promise<PromptSegment[]> {
		if (this.promptSegments !== null) return this.promptSegments;
		// ensurePromptsConfig 幂等：版本匹配时不动，版本过旧时迁移静态段（生产环境 index.ts 已调，此处兜底测试/直接构造场景）
		const { ensurePromptsConfig } = await import("./system-prompt");
		await ensurePromptsConfig(PROMPTS_FILE);
		const loaded = await loadPromptSegments(PROMPTS_FILE);
		// im-channel 段不落盘（savePromptSegments 剔除），运行时补回占位
		this.promptSegments = ensureImChannelSegment(
			loaded ?? DEFAULT_PROMPT_SEGMENTS,
		);
		// im-push 段同样不落盘，运行时补回（im-channel 之后、memory-policy 之前）
		this.promptSegments = ensureImPushSegment(this.promptSegments);
		// scheduled-tasks 段同样不落盘，运行时补回（memory-policy 之前、im-push 之后）
		this.promptSegments = ensureScheduledTasksSegment(this.promptSegments);
		return this.promptSegments;
	}

	/** 后绑定 im_push_to 全局执行器（index.ts 在 channelManager 构造后调用）。 */
	setImPushExecutor(
		executor: (contact: string, message: string) => Promise<string>,
	): void {
		this.opts.imPushExecutor = executor;
	}

	/** 后绑定 list_contacts 全局执行器（channelManager 晚置，index.ts 构造后调用）。 */
	setListContactsExecutor(
		executor: (channelId?: string) => Promise<string>,
	): void {
		this.opts.listContactsExecutor = executor;
	}

	/**
	 * 启动或复用一个会话。
	 * 同 sessionId 命中 Map 缓存则直接返回；进程崩溃/标脏则重建；否则创建新 pi 进程。
	 * 并发调用时共享同一个创建 Promise。
	 */
	async ensureStarted(
		projectId: string,
		agentName: AgentName,
		sessionId: string,
		opts?: { imChannelContext?: string; imPush?: ImPushInjection },
	): Promise<SessionHandle> {
		// 命中缓存：进程已崩溃则拆除重建；agentName 不一致也拆除（新会话页 getCommands
		// 兜底已用默认 agent 启动进程，用户切换后发送若复用会把消息交给旧 agent）；
		// 否则按 dirty 标记决定重建或直接复用
		const existing = this.sessions.get(sessionId);
		if (existing) {
			if (
				existing.crashed ||
				!existing.client.isAlive() ||
				existing.meta.agentName !== agentName
			) {
				this._teardownSession(sessionId);
			} else {
				// 复用缓存即视为"会话被访问"（如打开会话查看消息），刷新活跃时间避免被空闲回收
				existing.lastActiveAt = Date.now();
				return await this._reloadIfDirty(sessionId, existing);
			}
		}

		// 同 sessionId 正在创建中则复用创建 Promise
		const inFlight = this.starting.get(sessionId);
		if (inFlight) return await inFlight;

		// 之前被 dispose 过的 sessionId 允许重新创建
		this.disposed.delete(sessionId);

		const promise = this._createSession(
			projectId,
			agentName,
			sessionId,
			opts?.imChannelContext,
			opts?.imPush,
		);
		this.starting.set(sessionId, promise);
		try {
			return await promise;
		} finally {
			this.starting.delete(sessionId);
		}
	}

	/**
	 * 标记当前所有活跃会话为待重建（扩展/插件配置变更后调用）。
	 * 不立即重建——各会话在下次被 ensureStarted（切换/使用）时各自重建一次。
	 */
	markAllDirty(): void {
		for (const id of this.sessions.keys()) this.dirty.add(id);
	}

	/**
	 * 标记当前所有活跃会话为待重建（skill 目录增删 / skill 禁用后调用）。
	 * 与 markAllDirty 统一为进程重启（--skill 列表构造时固定，只能重启刷新）。
	 */
	markSkillsDirty(): void {
		for (const id of this.sessions.keys()) this.skillDirty.add(id);
	}

	/**
	 * 标记当前所有活跃会话为待整进程重建（provider 增删/改 model id 后调用）。
	 * provider-extension.ts 经 -e 参数在 pi 进程 spawn 时固化加载，session.reload()
	 * 热重载不会重读 -e——若走 markAllDirty（dirty 集合 → reloadExtensions 热重载），
	 * 运行中的 pi 进程仍持旧模型注册表，setModel(新 id) 会报 Model not found。
	 * 故与 markSkillsDirty 同走 skillDirty 集合，下次 ensureStarted 时整进程重建、
	 * 重新加载最新 provider-extension（与 --skill 列表构造时固化同理，只能重启刷新）。
	 */
	markProvidersDirty(): void {
		for (const id of this.sessions.keys()) this.skillDirty.add(id);
	}

	/** agent 重命名联动：更新活跃会话 meta，标 skillDirty 使下次 ensureStarted 重建 */
	renameAgentSessions(oldName: string, newName: string): void {
		for (const [id, handle] of this.sessions) {
			if (handle.meta.agentName === oldName) {
				this.sessions.set(id, {
					...handle,
					meta: { ...handle.meta, agentName: newName },
				});
				this.skillDirty.add(id);
			}
		}
	}

	/** 对话中切换智能体：运行中先 abort，拆除后按同一 sessionId 重建（jsonl 历史保留） */
	async switchAgent(sessionId: string, agentName: AgentName): Promise<void> {
		const old = this.sessions.get(sessionId);
		if (old?.busy) {
			try {
				await old.client.abort();
			} catch (e) {
				void e; /* 忽略 */
			}
		}
		const meta = old?.meta;
		// 先解析 projectId（old 存在时取 meta，无额外 I/O；old 为 null 时读盘兜底），
		// 并把持久化更新移到 teardown 之前：消除「teardown 后、starting.set 前」的异步竞态窗口。
		// 否则用户切换角色后立即发消息，ensureStarted 会因 sessions/starting 均为空而
		// 启动第二个 _createSession，两个 pi 进程并发创建同一 jsonl → 冲突失败 → 会话未启动。
		const projectId =
			meta?.projectId ??
			(await this.opts.projectStore.load()).sessions.find(
				(s) => s.id === sessionId,
			)?.projectId;
		if (!projectId) throw new Error(`会话不存在: ${sessionId}`);
		await this.opts.projectStore.setSessionAgent(sessionId, agentName);
		// 拆除 + 重建为连续同步段（无 await）：并发 ensureStarted 会命中 starting 复用同一创建 promise
		this._teardownSession(sessionId);
		const promise = this._createSession(projectId, agentName, sessionId);
		this.starting.set(sessionId, promise);
		try {
			await promise;
		} finally {
			this.starting.delete(sessionId);
		}
	}

	/** 计算 MCP direct 工具名（受限 agent 白名单与 listGlobalTools 用）；无 mcpStore 时返回空 */
	private async getMcpDirectToolNames(): Promise<string[]> {
		if (!this.opts.mcpStore) return [];
		try {
			const [servers, settings] = await Promise.all([
				this.opts.mcpStore.list(),
				this.opts.mcpStore.getGlobalSettings(),
			]);
			return await resolveMcpDirectToolNames(servers, settings);
		} catch (err) {
			console.error("[kernel] MCP direct 工具名计算失败，跳过:", err);
			return [];
		}
	}

	/** 全局工具清单：内置（DEFAULT_AGENT_TOOLS）+ MCP direct + 动态插件登记，供详情弹窗勾选。
	 *  剔除 subagent（宿主不允许直接暴露，关系网调起走 delegate）。
	 *  source 值：内置 → "内置"，MCP direct → "MCP"。 */
	async listGlobalTools(): Promise<{ name: string; source: string }[]> {
		const items = DEFAULT_AGENT_TOOLS.filter((t) => t !== "subagent").map(
			(name) => ({ name, source: "内置" }),
		);
		const seen = new Set(items.map((i) => i.name));
		// MCP direct 工具（kernel 侧按 mcp.json 计算，命名与 pi-mcp-adapter 一致）
		for (const t of await this.getMcpDirectToolNames()) {
			if (!seen.has(t)) {
				seen.add(t);
				items.push({ name: t, source: "MCP" });
			}
		}
		// 注：第三方扩展运行时注册的工具不在此列——pi 不给宿主查询已注册工具的接口
		// （RPC 无列工具命令、package.json 无 tools 声明），wa-pi 无法采集。扩展工具的
		// 放行靠默认 agent 的排除式路径（不配 tools 白名单时全部放行）。
		return items;
	}

	/**
	 * 命中缓存时：dirty 标记（skill / extension 配置变更）→ 重建进程；进行中则跳过等 idle。
	 */
	private async _reloadIfDirty(
		sessionId: string,
		handle: SessionHandle,
	): Promise<SessionHandle> {
		const isSkillDirty = this.skillDirty.has(sessionId);
		const isExtDirty = this.dirty.has(sessionId);
		if (!isSkillDirty && !isExtDirty) return handle;
		if (handle.busy || handle.followUpList.length > 0) return handle; // 进行中，保留 dirty 等 idle

		this.skillDirty.delete(sessionId);
		this.dirty.delete(sessionId);

		// skillDirty（agent 重命名 / 技能白名单变更）：改 agent 定义层（系统提示词 / 工具集），
		// session.reload() 不重新读 agent 配置 → 必须整进程重建。
		if (isSkillDirty) {
			return this._rebuildSession(sessionId, handle);
		}

		// dirty（扩展装卸）：走热重载。动态扩展走 pi 官方 packages 机制，session.reload() 重读
		// settings.json packages 让装卸立即生效；reload 保留进程 + -e 内置扩展，重放 session_start
		// 让活跃扩展重发 widget/status 恢复 UI。先发 extension_ui_reset 清被卸载扩展的 UI 残留。
		//
		// 安全检查：热重载经 prompt("/__!wa_pi_reload") 触发，依赖 pi 拦截为扩展命令。
		// 若命令未注册（扩展加载竞态 / pi 版本差异 / reload 后 runner 丢失注册），
		// pi 会把 /__!wa_pi_reload 当普通消息发给 LLM——prompt 仍成功返回（LLM 回复了），
		// catch 分支不会触发，导致内部命令泄漏到会话 transcript。
		// 发 prompt 前先验证命令是否注册，未注册直接走整进程重建。
		this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
			type: "extension_ui_reset",
		} as RpcEvent);
		try {
			const { commands } = await handle.client.getCommands();
			const hasReloadCmd = commands?.some(
				(c: any) => c.name === "__!wa_pi_reload",
			);
			if (!hasReloadCmd) {
				console.warn(
					`[kernel] 会话 ${sessionId} 未注册 __!wa_pi_reload 命令，回退整进程重建`,
				);
				return this._rebuildSession(sessionId, handle);
			}
			await handle.client.reloadExtensions();
			return handle;
		} catch (err) {
			// 兜底：热重载失败（桥接扩展未注册 __!wa_pi_reload / pi 旧版本 / 进程异常）
			// → 回退整进程重建（_rebuildSession 会再发一次 extension_ui_reset）。
			console.warn(
				`[kernel] 会话 ${sessionId} 热重载扩展失败，回退整进程重建:`,
				err,
			);
			return this._rebuildSession(sessionId, handle);
		}
	}

	/** 整进程重建：拆除旧进程 + 重新 _createSession（同一会话文件，历史不丢）+ 发 extension_ui_reset。 */
	private async _rebuildSession(
		sessionId: string,
		handle: SessionHandle,
	): Promise<SessionHandle> {
		this._teardownSession(sessionId);
		const promise = this._createSession(
			handle.meta.projectId,
			handle.meta.agentName,
			sessionId,
		);
		this.starting.set(sessionId, promise);
		try {
			const h = await promise;
			this.opts.onEvent(sessionId, h.meta.projectId, h.meta.agentName, {
				type: "extension_ui_reset",
			} as RpcEvent);
			return h;
		} finally {
			this.starting.delete(sessionId);
		}
	}

	private async _createSession(
		projectId: string,
		agentName: AgentName,
		sessionId: string,
		imChannelContext?: string,
		imPush?: ImPushInjection,
	): Promise<SessionHandle> {
		// 启动时写入内置 subagent 的 .md 定义文件（~/.pi/agent/agents/*.md），已存在不覆盖
		const agentsDir = join(WA_PI_DIR, "agents");
		seedBuiltinAgents(agentsDir);

		// 从 ProjectStore 拉 project + session 实体（校验存在性 + 拿 cwd / piSessionFile）
		const { projects, sessions } = await this.opts.projectStore.load();
		const project = projects.find((p) => p.id === projectId);
		if (!project) throw new Error(`项目不存在: ${projectId}`);
		if (!project.cwd) {
			throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);
		}

		const sessionEntity = sessions.find((s) => s.id === sessionId);
		if (!sessionEntity) throw new Error(`会话不存在: ${sessionId}`);
		if (!sessionEntity.piSessionFile) {
			throw new Error(`会话 piSessionFile 缺失: ${sessionId}`);
		}

		// 计算本次会话的 cwd（普通项目会话用 project.cwd；默认工作区会话用 resolveSessionCwd 推导）
		const cwd = resolveSessionCwd(sessionEntity, project);
		// 确保 cwd 存在（默认工作区可能尚未创建 workdir；普通项目 cwd 一般已存在）
		await mkdir(cwd, { recursive: true });

		// 读 agent 配置（系统提示词 / 工具 / 模型 / thinking level）
		const config = this.opts.configStore
			? await this.opts.configStore.getAgent(agentName)
			: null;

		// 解析启用 skill 的目录路径，传给 pi 的 --skill 参数。
		// 先按全局启用状态扫描，再按 agent 配置的 skills 白名单过滤（空数组 = 全量）。
		// skillsAllOff=true 表示显式全不选：不传任何技能路径。
		const enabledSkills = await resolveEnabledSkills(
			this.opts.skillManager,
			this.opts.extensionManager,
		);
		const additionalSkillPaths = (
			config?.skillsAllOff
				? []
				: config?.skills?.length
					? enabledSkills.filter((s) => config.skills!.includes(s.name))
					: enabledSkills
		).map((s) => s.path);

		// host-controlled 记忆：预取全局+项目记忆快照注入系统提示词；记忆读取失败降级为空快照。
		// 「注入提示」开关（memoryPolicyStyle=none）关闭时不注入。
		const memConfig = await this.opts.memoryStore
			?.getConfig()
			.catch(() => undefined);
		const memorySnapshot =
			memConfig?.memoryPolicyStyle === "none"
				? ""
				: await buildMemorySnapshot(WA_PI_DIR, cwd).catch((err) => {
						console.error(`[kernel] 读取记忆快照失败，跳过注入:`, err);
						return "";
					});

		// 关系网调起：delegate/fleet 工具的可用名单与 roster（与迁移前一致，内置 subagent 类型始终可调用）
		const askToNames = config?.partners?.askTo ?? [];
		const askToConfigs = (
			await Promise.all(askToNames.map((n) => this.opts.configStore!.getAgent(n)))
		).filter((c): c is NonNullable<typeof c> => c != null);
		// 加载系统提示词段落配置（首次加载后缓存）
		const promptSegments = await this.getPromptSegments();
		const askToTargets = askToConfigs.map((c) => ({
			name: c.displayName,
			description: c.description,
			delegationHints: c.delegationHints,
		}));

		// resolveSpawnConfig：从 ConfigStore 读 WaPi 配置（用户在 UI 设置的 model/thinking/tools/skills），
		// 内置 subagent 类型不在 store 里——从 SUBAGENT_TYPES 常量读元信息 + ~/.pi/agent/agents/*.md 读系统提示词。
		const resolveSpawnConfig = async (
			agentName: string,
		): Promise<WaPiSpawnConfig | null> => {
			// 内置 subagent 类型：从 SUBAGENT_TYPES 元信息 + agents/*.md 读定义（用户可覆盖）
			if (isSubagentType(agentName)) {
				const builtin = SUBAGENT_TYPES.find((t) => t.name === agentName);
				if (builtin) {
					const prompt = await readBuiltinAgentPrompt(agentsDir, agentName);
					// 读取用户保存的 model/thinking 覆盖（~/.pi/agent/subagent-overrides.json）
					const { getSubagentOverride } = await import("./subagent-store");
					const { SUBAGENT_OVERRIDES_FILE } = await import("@wa-pi/shared");
					const override = await getSubagentOverride(
						SUBAGENT_OVERRIDES_FILE,
						agentName,
					);
					// 校验 model：WaPi 模型标识固定为 "provider/modelId" 格式；不含 "/" 的视为无效并降级
					let model = override?.model ?? null;
					if (model && !model.includes("/")) {
						console.warn(
							`[kernel] 子智能体「${agentName}」的 override model "${model}" 格式无效（缺少 /），已降级为跟随主智能体`,
						);
						model = null;
					}
					return {
						name: builtin.name,
						description: builtin.description,
						systemPrompt: prompt,
						// 跟随主模型：无 override 时用主会话当前模型（prompt 时记录到 handle.currentModel）
						model: model ?? this.sessions.get(sessionId)?.currentModel ?? null,
						thinking:
							override?.thinking ??
							this.sessions.get(sessionId)?.currentThinking ??
							null,
						tools: builtin.readOnly ? ["read", "bash", "grep", "find", "ls"] : [],
						skills: [],
					};
				}
			}
			// 命名智能体：从 ConfigStore 读配置
			const cfg = await this.opts.configStore
				?.getAgent(agentName)
				.catch(() => null);
			if (!cfg) return null;
			let cfgModel = cfg.model;
			if (cfgModel && !cfgModel.includes("/")) {
				console.warn(
					`[kernel] 智能体「${agentName}」的 model "${cfgModel}" 格式无效（缺少 /），已降级为跟随主智能体`,
				);
				cfgModel = null;
			}
			return {
				name: cfg.displayName,
				description: cfg.description,
				systemPrompt: cfg.systemPromptBody ?? "",
				// 跟随主模型：agent 未单独配置时用主会话当前模型
				model: cfgModel ?? this.sessions.get(sessionId)?.currentModel ?? null,
				thinking: cfg.thinking,
				tools: cfg.tools,
				skills: cfg.skills,
				skillsAllOff: cfg.skillsAllOff,
			};
		};

		// 会话级子代理遥测收集器：随 spawnFn 生命周期创建，_teardownSession 时 flush
		const subagentTelemetry = new SubagentTelemetry();
		// 在跑子代理的中止控制器登记表：spawn 闭包每次派发创建/移除，
		// abort()/_teardownSession 级联触发（stop 主会话时子代理一起停）
		const subagentAborts = new Set<AbortController>();
		// 子进程必须加载 provider-extension（providers.json → 自定义 provider + apiKey），
		// 否则「跟随主模型」传入的 --model 在子进程里查无此 provider，报 No API key
		const providerExtPath = join(GENERATED_DIR, "provider-extension.ts");

		// 子代理进度透传槽位：spawn 闭包在 _createSession 里构造一次（此时绑定 onProgress 闭包），
		// 但 bridgeCtx.handleTool 是每次工具调用时才执行。handleTool 接到的 onProgress 是「本次调用」的，
		// 无法直接传给已绑定的 spawn 闭包。解法：handleTool 调用前把 onProgress 写入本槽位，
		// spawn 闭包的 onProgress 从槽位取最新值；finally 清空避免泄漏到下次调用。
		// fleet 在同一 handleTool await 内并发多个子代理，它们共享同一 onProgress（fleet 调用的 toolCallId），
		// 槽位在整个 handleTool 调用期间稳定，天然不串。
		// 注意：槽位签名是 (event) => void（对齐 bridge-registry 的 onProgress），
		// emit 闭包自身已绑定 toolCallId（handleBridgeStream 里捕获），无需再传。
		let currentSubagentOnProgress:
			| ((event: SubagentProgressEvent) => void)
			| undefined;
		// 调用级断连信号槽位：与 currentSubagentOnProgress 同生命周期（handleTool 调用期间稳定），
		// spawn 闭包经 getCallSignal 取值叠加中止（bridge 流式断连 → 中止子代理）
		let currentCallSignal: AbortSignal | undefined;

		const spawnFn = makeSpawnFn({
			resolveConfig: resolveSpawnConfig,
			extensionPaths: existsSync(providerExtPath) ? [providerExtPath] : [],
			// 派发前自愈：extension 文件可能与 providers.json 不同步（空壳/过时/手动改坏），
			// 导致子进程报 "No API key found"。按需重生，保证子进程加载到含所需 provider 的 extension。
			ensureExtension: this.opts.providerStore
				? async (requiredSlug?: string) => {
						// mtime 兜底：providers.json 被手改（绕过 provider:save）时 extension 不会
						// 自动刷新，派发前比对 mtime，过期则重生成，保证子进程加载到含最新
						// contextWindow 的 extension。与 extensionCoversProvider 并列为重生成条件。
						const stale = await isProviderExtensionStale(
							PROVIDERS_FILE,
							providerExtPath,
						);
						// 无具体 slug（跟随主模型）、extension 不含该 slug、或 providers.json
						// 比 extension 更新——任一命中即重新生成
						if (
							stale ||
							!requiredSlug ||
							!extensionCoversProvider(providerExtPath, requiredSlug)
						) {
							await ensureProviderExtensionRegistered(this.opts.providerStore!);
						}
					}
				: undefined,
			resolveSkillPaths: async (skillNames) => {
				// 从全局启用的技能中按名称解析路径
				const enabled = await resolveEnabledSkills(
					this.opts.skillManager,
					this.opts.extensionManager,
				);
				return enabled
					.filter((s) => skillNames.includes(s.name))
					.map((s) => s.path);
			},
			cwd,
			abortRegistry: subagentAborts,
			getCallSignal: () => currentCallSignal,
			onSpawnComplete: (input) => subagentTelemetry.record(input),
			// spawn 闭包的 onProgress：从槽位取本次 handleTool 调用注入的 onProgress，
			// 再叠加会话级 onSubagentProgress（注入 sessionId 后广播到 SSE）。
			// 槽位为空时（非 bridge 流式调用路径，如直接调 spawnFn 的测试）仅走 onSubagentProgress。
			// 槽位签名是 (event)，toolCallId 由 handleBridgeStream 的 emit 闭包自带。
			onProgress: (toolCallId, event) => {
				currentSubagentOnProgress?.(event);
				this.opts.onSubagentProgress?.(sessionId, toolCallId, event);
			},
		});

		// 内置 subagent 的委派引导从 ~/.pi/agent/agents/*.md 的 frontmatter 提取（与命名智能体统一来源）
		const { getSubagentInfo } = await import("./subagent-info");
		const builtinSubagents = await getSubagentInfo([]);
		const builtinHints: Record<
			string,
			import("@wa-pi/shared").DelegationHints | undefined
		> = {};
		for (const s of builtinSubagents) {
			if (s.delegationHints) builtinHints[s.name] = s.delegationHints;
		}
		// 可用子智能体总览段：内置 + 命名统一列表（注入系统提示词 delegate-roster 段）
		const delegateRoster = buildDelegateRoster(
			askToTargets,
			builtinHints,
			agentsDir,
		);

		// delegate/fleet 工具实例（execute 由 bridge ctx 调用；schema 在 wa-pi-bridge 扩展里）
		const delegateTool = makeDelegateTool({
			askTo: askToTargets,
			spawn: spawnFn,
		});
		const fleetTool = makeFleetTool({ askTo: askToTargets, spawn: spawnFn });

		// bridge 会话上下文：ask/memory 走默认工厂，delegate/fleet 接宿主实现；
		// reviewEnabled=false 时记忆工具返回关闭提示（对齐迁移前「不注册记忆工具」的行为）
		const memoryEnabled = memConfig?.reviewEnabled !== false;
		const am = this; // handleTool 是对象方法简写，this 指向 bridgeCtx；AgentManager 实例另存
		const defaultCtx = makeDefaultBridgeContext({
			sessionId,
			cwd,
			memoryStores: {
				global: getGlobalMemoryStore(WA_PI_DIR),
				project: getProjectMemoryStore(WA_PI_DIR, cwd),
			},
		});
		const bridgeCtx: BridgeSessionContext = {
			cwd,
			async handleTool(
				tool,
				toolCallId,
				params,
				signal,
				// 子代理进度回调（流式 bridge 经 handleBridgeStream 注入）：
				// delegate/fleet 执行期间由 spawn 闭包的 onProgress 触发，回写 NDJSON progress 帧。
				onProgress,
			): Promise<BridgeToolResult> {
				// delegate/fleet：把本次调用的 onProgress 写入会话级槽位，spawn 闭包从槽位取最新值；
				// finally 清空避免泄漏到下次工具调用（如 ask/memory 不需要进度）。
				// fleet 在此 await 内并发多个子代理，共享同一 onProgress + toolCallId，槽位稳定不串。
				if (tool === "delegate" || tool === "fleet") {
					currentSubagentOnProgress = onProgress;
					currentCallSignal = signal;
					try {
						if (tool === "delegate") {
							return await delegateTool.execute(
								toolCallId,
								params as { agent: string; task: string },
							);
						}
						return await fleetTool.execute(
							toolCallId,
							params as { tasks: Array<{ agent: string; task: string }> },
						);
					} finally {
						currentSubagentOnProgress = undefined;
						currentCallSignal = undefined;
					}
				}
				// im_push_to：定时任务会话注入优先；主聊天走全局 executor（channelManager
				// 全局长连接，调用时实时按 contact 解析路由，无会话级注册状态）。工具始终注册。
				if (tool === "im_push_to") {
					const execute = imPush?.execute ?? am.opts.imPushExecutor;
					if (!execute) {
						return {
							content: [
								{
									type: "text",
									text: "IM 推送功能未就绪（kernel 未接线 channelManager）",
								},
							],
							details: { error: "im push unavailable" },
						};
					}
					const p = params as { contact: string; message: string };
					try {
						const text = await execute(p.contact, p.message);
						return { content: [{ type: "text", text }], details: {} };
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `推送失败：${error}` }],
							details: { error },
						};
					}
				}
				// list_contacts：查询当前系统可用联系人（只读）。走全局 executor（channelManager
				// 全局长连接，调用时实时按 channelId 拉取联系人列表），工具始终注册。
				if (tool === "list_contacts") {
					const execute = am.opts.listContactsExecutor;
					if (!execute) {
						return {
							content: [
								{
									type: "text",
									text: "通讯录未就绪（kernel 未接线 channelManager）",
								},
							],
							details: { error: "contacts unavailable" },
						};
					}
					const p = params as { channelId?: string };
					try {
						const text = await execute(p.channelId);
						return { content: [{ type: "text", text }], details: {} };
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `获取联系人失败：${error}` }],
							details: { error },
						};
					}
				}
				if (!memoryEnabled && tool.startsWith("memory_")) {
					return {
						content: [
							{ type: "text", text: "记忆功能已关闭（reviewEnabled=false）" },
						],
						details: { error: "memory_disabled" },
					};
				}
				// browser_*：宿主浏览器自动化工具（Bun.WebView）。分派到 browserManager，
				// 执行逻辑在 browser-tools.ts（导航/操作/截图/关闭）。
				if (tool.startsWith("browser_")) {
					return await handleBrowserTool(am.browserManager, sessionId, tool, params);
				}
				return defaultCtx.handleTool(tool, toolCallId, params, signal);
			},
		};

		// 组合系统提示词并写入临时文件（pi 的 --system-prompt 支持文件路径，规避命令行长度限制）。
		// 角色提示词（agent.md 正文 systemPromptBody）非空时替代默认 base 提示词。
		// 注意：prompts.json 的 base.content（用户全局覆盖）优先级最高——
		// renderSegment 里 segment.content 非空时直接使用，不看 defaultBasePrompt。
		const defaultBasePrompt = config?.systemPromptBody
			? config.systemPromptBody
			: WA_PI_DEFAULT_BASE_PROMPT;
		const composedPrompt = composePrompt(promptSegments, {
			defaultBasePrompt,
			delegateRoster,
			builtinSkillsDir: BUILTIN_SKILLS_DIR,
			// 记忆写入策略引导：按 memoryPolicyStyle 注入（full 完整版 / compact 精简版 / none 不注入）。
			// 这是 agent「主动写记忆」的核心引导——缺失时 agent 只回复文本、从不调用 memory_add。
			memoryPolicy:
				memConfig?.memoryPolicyStyle === "compact"
					? COMPACT_MEMORY_POLICY_PROMPT
					: memConfig?.memoryPolicyStyle === "none"
						? ""
						: DEFAULT_MEMORY_POLICY_PROMPT,
			// 记忆快照不再注入 composePrompt，改为 --append-system-prompt 挂载到末尾，
			// 使核心提示词完全静态化，最大化 LLM prompt caching 前缀命中率。
			memorySnapshot: "",
			// IM 渠道附加提示词（仅渠道会话传入，非渠道会话为空 → im-channel 段不出现）。
			// 渠道提示词变更后由调用方 markAllDirty() 触发下次 ensureStarted 重建生效。
			imChannelContext: imChannelContext ?? "",
			// IM 推送引导：定时任务会话用具体目标版；其余会话注入通用常驻版——
			// 工具始终注册后任何会话都可能出现 @im-push-to 标记，引导需常驻说明语义
			// （参照 delegate-mechanism 常驻段模式；联系人在消息标记中自描述）。
			imPushContext: imPush?.targets?.length
				? buildImPushSystemPrompt(imPush.targets)
				: GENERIC_IM_PUSH_PROMPT,
			// 定时任务管理引导（含路径/CLI 指引）：由构造函数产出经 ctx 注入，不在渲染层写死
			scheduledTasksContext: buildScheduledTasksSystemPrompt(),
		});
		const tmpDir = join(WA_PI_DIR, "tmp", "sysprompts");
		await mkdir(tmpDir, { recursive: true });
		const promptFile = join(tmpDir, `${sessionId}.md`);
		await writeFile(promptFile, composedPrompt, "utf8");

		// 记忆快照：写入独立文件，经 --append-system-prompt 追加到提示词末尾。
		// pi 在 customPrompt 之后拼接 appendSystemPrompt → 不影响前缀缓存。
		let memorySnapshotFile: string | undefined;
		if (memorySnapshot) {
			memorySnapshotFile = join(tmpDir, `${sessionId}-memory.md`);
			await writeFile(memorySnapshotFile, memorySnapshot, "utf8");
		}

		// 工具放行策略：
		// - 默认（agent 未显式配置 tools）：排除式——不传 --tools，仅 -xt subagent；
		//   内置 7 工具 + 扩展工具 + MCP direct 工具全部可用（扩展工具靠 pi 进程加载扩展后
		//   运行时注册，wa-pi 不感知其工具名但默认全部放行）。
		// - 显式配置 tools：白名单——config.tools ∪ MCP direct 工具名。
		// 动态扩展走 pi 官方 packages 机制（settings.json packages + ~/.pi/agent/npm/），
		// 不再经 -e；-e 只传内置（PKG_EXTENSIONS）+ provider-extension + wa-pi-bridge。
		const extensionPaths = buildAdditionalExtensionPaths();

		const restricted = !!config?.tools?.length;
		const toolArgs: { tools?: string[]; excludeTools?: string[] } = restricted
			? {
					tools: [
						// 受限 agent 白名单无条件并入 im_push_to：工具始终注册（bridge 扩展），
						// 不并入会被白名单挡掉（主聊天 @im-push-to 标记会话同样需要推送能力）
						"im_push_to",
						...resolveAgentTools(config!.tools!, await this.getMcpDirectToolNames()),
					],
				}
			: { excludeTools: [...ALWAYS_EXCLUDED_TOOLS] };

		// 注册 bridge 上下文（pi 进程内 wa-pi-bridge 扩展回调用）
		registerBridgeSession(sessionId, bridgeCtx);

		// thinking level 映射（disabled→off，max→xhigh，其余透传）
		const thinking = mapThinkingLevel(config?.thinking ?? "medium");

		// spawn pi rpc 子进程
		const createClient: CreateClientFn =
			this.opts.createClientFn ?? ((o) => new RpcClient(o));
		const handle: SessionHandle = {
			// SAFETY: client 为占位，随后的 _initClient/handle 流程立即赋值真实 RpcClient；
			// 会话生命周期内使用时必已初始化（busy 门控保证）。
			client: null as unknown as RpcClient,
			cwd,
			meta: { projectId, agentName },
			busy: false,
			thinkingSince: null,
			turnUserAt: null,
			messages: [],
			followUpList: [],
			steerList: [],
			promptFile,
			memorySnapshotFile: memorySnapshotFile ?? null,
			piSessionFile: sessionEntity.piSessionFile,
			crashed: false,
			disposed: false,
			autoResumeCount: 0,
			subagentTelemetry,
			subagentAborts,
			currentModel: null,
			currentThinking: null,
			netDegraded: false,
			lastActiveAt: Date.now(),
		};
		const client = createClient({
			cliPath: resolvePiCliPath(),
			runtime: resolvePiRuntime(),
			args: buildPiArgs({
				sessionFile: sessionEntity.piSessionFile,
				systemPromptFile: promptFile,
				appendSystemPrompt: memorySnapshotFile,
				extensionPaths: extensionPaths,
				skillPaths: additionalSkillPaths,
				noSkills: true,
				offline: true,
				thinking,
				name: `${agentName}-${sessionId.slice(0, 8)}`,
				...toolArgs,
			}),
			cwd,
			env: {
				PI_CODING_AGENT_DIR: WA_PI_DIR,
				WA_PI_BRIDGE_URL: this.opts.bridgeBaseUrl?.() ?? "",
				WA_PI_BRIDGE_TOKEN: getBridgeToken(),
				WA_PI_SESSION_ID: sessionId,
				// 定时任务归属当前会话项目：agent 调 CLI 建任务时自动用本项目（隔离）
				WA_PI_SCHEDULER_PROJECT_ID: projectId,
				// 定时任务会话：联系人列表注入 env，bridge 扩展读到才注册 im_push_to
				...(imPush?.targets?.length
					? {
							WA_PI_IM_PUSH_TARGETS: imPush.targets.join(","),
						}
					: {}),
			},
			onEvent: (e) => this._onSessionEvent(sessionId, e),
			onUiRequest: (req) =>
				this._onExtUiRequest(sessionId, projectId, agentName, req),
			onExit: (code, signal) =>
				this._onProcessExit(sessionId, code, signal, handle),
		});
		handle.client = client;

		// 提前注册 handle 到 map，让 abort / queue 操作在 start 期间即可用
		this.sessions.set(sessionId, handle);

		try {
			await client.start();
		} catch (err) {
			this._teardownSession(sessionId);
			throw err;
		}

		// _createSession 期间收到的 abort 请求：client 已注册，立即执行
		if (this.pendingAborts.has(sessionId)) {
			this.pendingAborts.delete(sessionId);
			try {
				await client.abort();
			} catch {
				/* abort 失败不阻塞创建 */
			}
		}

		// 历史消息快照（ws-server 的 session:messages 依赖该同步读取）。
		// 重启兜底：对「无 result 的 ask 调用」在快照里注入 cancelled，避免前端展示悬挂提问。
		try {
			const messages = await client.getMessages();
			handle.messages = reconcileDanglingAsks(messages) as any[];
		} catch (err) {
			// dispose 打断 getMessages 是预期路径（reapIdleSessions/session:delete 与冷启动并发），
			// 静默不打印；非 dispose 的拉取失败（进程崩溃等）仍打 error 便于排障。
			if (!this.disposed.has(sessionId)) {
				console.error(`[kernel] session ${sessionId} 拉取历史消息失败:`, err);
			}
			handle.messages = [];
		}

		// 如果创建过程中被 dispose，清理已提前注册的 handle
		if (this.disposed.has(sessionId)) {
			this.disposed.delete(sessionId);
			this._teardownSession(sessionId);
			const err = new Error(`会话已清理: ${sessionId}`);
			(err as Error & { code?: string }).code = "SESSION_DISPOSED";
			throw err;
		}

		return handle;
	}

	// ---- 事件与队列 ----

	/** pi 事件入口：维护 busy/队列，再转发给上层 */
	private _onSessionEvent(sessionId: string, event: RpcEvent): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;

		switch (event.type) {
			case "agent_start":
				handle.busy = true;
				handle.thinkingSince = Date.now();
				// 新一轮开始说明网络可能已恢复：清除 transient degraded 标记，
				// 避免上一轮 transient 错误后 netDegraded 永久卡死 drain（原来只能靠用户重发清除）。
				if (handle.netDegraded) handle.netDegraded = false;
				break;
			case "message_end":
				if (event.message) {
					handle.messages.push(event.message);
				}
				// 本轮 user 落盘时刻（≈ jsonl 行级落盘）：整轮耗时的起点。
				// 不能用 message.timestamp——Pi 单块轮 assistant 消息对象在 prompt 时预创建，
				// message.timestamp ≈ user 时刻，算出的时长≈0；真实耗时看落盘时刻。
				if ((event.message as any)?.role === "user") handle.turnUserAt = Date.now();
				// agent 回复完成视为活跃（与磁盘 touchSession 同步），刷新空闲回收计时
				handle.lastActiveAt = Date.now();
				break;
			case "agent_end": {
				// 整轮耗时：user 落盘（kernel 收到 user message_end）→ agent_end 到达
				// （≈ 最后 assistant 落盘后）。与 session-history 历史注入（行级落盘时刻）同语义。
				// 仅成功轮附加；失败回合/无 user 不附加。
				const msgs = handle.messages;
				const lastAssistant = [...msgs]
					.reverse()
					.find((m: any) => m?.role === "assistant");
				if (
					handle.turnUserAt != null &&
					lastAssistant &&
					lastAssistant.stopReason !== "error"
				) {
					(event as any).elapsedMs = Date.now() - handle.turnUserAt;
				}
				// 结算后重置起点，避免下一无 user 轮（如 steer 触发）误用上一轮旧值算跨轮时长
				handle.turnUserAt = null;
				break;
			}
			case "agent_settled":
				handle.busy = false;
				handle.thinkingSince = null;
				// 一轮对话结束：清空该会话残留的 ask 条目（含断开保留的 disconnected，防泄漏）
				askRegistry.clearSession(sessionId);
				// transient 网络错误期间跳过 drain：此时网络仍不可用，
				// 自动发送排队/引导消息会再失败。队列保留，等用户重发恢复。
				if (handle.netDegraded) {
					break;
				}
				// 优先 drain 引导消息（如果 pi 已投递则 queue_update 会清掉 steerList）
				if (handle.steerList.length > 0) {
					const text = handle.steerList.shift()!;
					this._emitLocalQueueUpdate(sessionId, handle);
					void this._sendPromptNow(sessionId, handle, text).catch((err) => {
						console.error(`[kernel] session ${sessionId} steer drain 失败:`, err);
					});
				} else if (handle.followUpList.length > 0) {
					// 无引导消息时才 drain 排队消息
					const entry = handle.followUpList.shift()!;
					this._emitLocalQueueUpdate(sessionId, handle);
					void this._sendPromptNow(
						sessionId,
						handle,
						entry.text,
						entry.images,
					).catch((err) => {
						console.error(`[kernel] session ${sessionId} followUp drain 失败:`, err);
					});
				} else if (this.skillDirty.has(sessionId) || this.dirty.has(sessionId)) {
					// 真正 idle（无排队/引导消息）且有 dirty：补重载。对话中装卸插件被 busy 挡住
					// （保留 dirty），对话结束（agent_settled）且队列空时补热重载/重建。
					void this._reloadIfDirty(sessionId, handle).catch((err) => {
						console.error(`[kernel] session ${sessionId} idle 后补重载失败:`, err);
					});
				}
				break;
			// pi 投递引导消息后 queue_update 的 steering 为空 → 同步清 steerList 防重复
			case "queue_update":
				if ((event as any).steering && (event as any).steering.length === 0) {
					handle.steerList = [];
				}
				break;
		}

		// pi 的 queue_update.followUp 始终为空（pi 不管排队），
		// 转发前用 WaPi 本地队列状态替换（不拼接！pi steering 和 steerList 是同一份）
		if (event.type === "queue_update") {
			event = {
				...event,
				steering: [...handle.steerList],
				followUp: handle.followUpList.map((e) => e.text),
			};
		}

		this.opts.onEvent(
			sessionId,
			handle.meta.projectId,
			handle.meta.agentName,
			event,
		);
	}

	/** 进程退出：非主动 dispose 的退出视为崩溃，合成错误事件通知前端，标记待重建 */
	private _onProcessExit(
		sessionId: string,
		code: number | null,
		signal: string | null,
		handle: SessionHandle,
	): void {
		if (handle.disposed) return;
		// 孤儿会话回滚：piSessionFile 不存在说明从未 prompt（如 getCommands 兜底创建后
		// 用户离开）。删除记录避免「列表出现、点进去空白」；正常会话崩溃不删（有消息文件）。
		if (handle.piSessionFile && !existsSync(handle.piSessionFile)) {
			console.warn(
				`[kernel] 孤儿会话回滚：${sessionId} 从未写入消息文件，删除记录`,
			);
			void this.opts.projectStore
				.deleteSession(sessionId)
				.catch((e) => console.error(`[kernel] 孤儿回滚删除失败 ${sessionId}:`, e));
			this.opts.onSessionRollback?.(sessionId);
			return;
		}
		handle.crashed = true;
		handle.busy = false;
		handle.thinkingSince = null;
		// 进程已死：挂起的扩展对话永远等不到应答，以 cancelled 解决防 registry 泄漏
		extUiRegistry.cancelAllForSession(sessionId);
		console.error(
			`[kernel] session ${sessionId} pi 进程意外退出 (code=${code} signal=${signal ?? "none"})`,
		);
		// 崩溃现场落盘：子进程 stderr 尾部（Bun/Node 原生崩溃的 panic 原文在这）
		// 是定位 code=133/139 类信号崩溃的唯一线索，内存尾巴随对象丢弃即失。
		// 异步追加到 <WA_PI_DIR>/logs/agent-crash.log；getStderrTail 用可选链兼容
		// 测试假 client（退出处理链路上任何异常都不允许影响错误事件与重建流程）。
		try {
			logAgentCrash(join(process.env.WA_PI_DIR ?? "", "logs", "agent-crash.log"), {
				sessionId,
				agentName: handle.meta.agentName,
				code,
				signal,
				pid: handle.client.pid ?? null,
				stderrLines: handle.client.getStderrTail?.() ?? [],
			});
		} catch (e) {
			void e;
		}
		// 合成 message_end 错误事件：复用 extractSdkErrorMessage → 前端 ⚠️ 渲染管线
		this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: `agent 进程意外退出 (code=${code})，请重新发送消息`,
				timestamp: Date.now(),
			},
		});
	}

	/** pi 扩展 dialog 请求（select/confirm/input/editor）：注册 pending + 广播给前端，阻塞等应答 */
	private _onExtUiRequest(
		sessionId: string,
		projectId: string,
		agentName: AgentName,
		req: RpcUiRequest,
	): Promise<UiResponseFields> {
		const promise = extUiRegistry.register(sessionId, req);
		this.opts.onEvent(sessionId, projectId, agentName, {
			type: "extension_dialog",
			requestId: req.id,
			method: req.method,
			title: typeof req.title === "string" ? stripAnsi(req.title) : undefined,
			message:
				typeof req.message === "string" ? stripAnsi(req.message) : undefined,
			options: Array.isArray(req.options)
				? req.options.map((o) => stripAnsi(String(o)))
				: undefined,
			placeholder: req.placeholder,
			prefill: req.prefill,
			timeout: req.timeout,
		});
		return promise;
	}

	/** 立即发送 prompt（busy 置位 + 失败回退） */
	private async _sendPromptNow(
		sessionId: string,
		handle: SessionHandle,
		text: string,
		images?: ImageContent[],
	): Promise<void> {
		// pi RPC 模式不解析内置斜杠命令（仅交互模式解析，见 pi.dev/docs/latest/rpc：
		// builtin TUI 命令不会通过 prompt 执行），文本若按普通 prompt 发出会被当作
		// user 消息发给 LLM，压缩从不发生。kernel 拦截的内置命令（清单与匹配规则
		// 统一在 shared matchKernelCommand）显式转对应 RPC 调用。
		// 覆盖 busy 排队 drain / steer 空闲直发等所有经过 _sendPromptNow 的路径。
		if (matchKernelCommand(text) === "compact") {
			await this._runCompactCommand(sessionId, handle, text);
			return;
		}
		// 发送前自动压缩防护：上下文将超限时先 compact 再继续，避免 400
		await this._autoCompactIfNeeded(sessionId, handle);
		handle.busy = true;
		// 用户重发触发直接 prompt：网络已恢复，清除 transient degraded 标记，恢复 drain。
		if (handle.netDegraded) handle.netDegraded = false;
		try {
			await handle.client.prompt(
				text,
				images && images.length > 0 ? { images } : undefined,
			);
		} catch (err) {
			handle.busy = false;
			handle.thinkingSince = null;
			throw err;
		}
		// 用户发送消息（含排队 drain / steer 空闲直发）视为活跃，刷新空闲回收计时
		handle.lastActiveAt = Date.now();
		// 扩展命令（如 /goal）拦截 prompt 后 agent_start 不会触发，
		// 乐观设置的 busy=true 必须复位，否则前端永远显示"思考中"。
		// 正常 prompt 场景 agent_start 在 ms 级内触发并设置 thinkingSince，
		// 此处的延迟检查只在 thinkingSince 仍为 null 时复位 busy。
		setTimeout(() => {
			if (handle.busy && handle.thinkingSince === null) {
				handle.busy = false;
				// 扩展命令不产生任何 agent 事件：前端 optimisticSend 的 thinking/loading
				// 占位等不到终态事件，会一直转圈。合成 agent_end 让前端退出思考态。
				this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
					type: "agent_end",
				});
			}
		}, 50);
	}

	/**
	 * 执行 /compact 压缩上下文命令：转 pi RPC compact（自定义指令透传）。
	 *
	 * 压缩是长耗时操作（LLM 摘要生成），RPC 会 await 到压缩完成才返回；期间保持
	 * busy 防并发。完成后合成 agent_end（前端退出思考态 + /compact 检测触发 token 刷新）
	 * 与 agent_settled（复位 busy + drain 压缩期间排队的消息——pi 手动 compact 后
	 * 不会发 agent_settled，需 kernel 补）。失败复用 message_end{stopReason:"error"}
	 * 错误渲染管线播报，并同样合成 agent_end 防止思考态卡死。
	 */
	private async _runCompactCommand(
		sessionId: string,
		handle: SessionHandle,
		text: string,
	): Promise<void> {
		const trimmed = text.trim();
		const customInstructions =
			trimmed === "/compact"
				? undefined
				: trimmed.slice("/compact".length).trim() || undefined;
		handle.busy = true;
		try {
			await handle.client.compact(customInstructions);
		} catch {
			handle.busy = false;
			handle.thinkingSince = null;
			// 压缩失败（如会话太小 / 已压缩过）：pi 已 emit compaction_end{errorMessage}，
			// 前端 compaction_end case 负责展示失败文案（单一来源，避免与 message_end 重复）。
			// 这里只合成 agent_end 让前端退出思考态（压缩不产生 agent 事件）。
			this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
				type: "agent_end",
			});
			return;
		}
		handle.busy = false;
		handle.thinkingSince = null;
		handle.lastActiveAt = Date.now();
		// 压缩完成：合成 agent_end（前端退出思考态 + 触发 /compact token 刷新）
		this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
			type: "agent_end",
		});
		// 合成 agent_settled：走内部事件入口（复位 busy + drain 压缩期间排队的
		// steer/followUp 消息），尾部转发 opts.onEvent 通知前端
		this._onSessionEvent(sessionId, { type: "agent_settled" } as RpcEvent);
	}

	/**
	 * 发送前自动压缩防护。
	 * 当前上下文占用超过窗口一定比例（AUTO_COMPACT_USAGE_RATIO）时，先 compact 再继续发送，
	 * 作为 pi「prompt preflight 隐性压缩 + turn 结束后阈值压缩」之外的发送前提前量。
	 * 数据源必须与 pi 同源（getSessionStats().contextUsage），否则会出现「kernel 不压、pi 在
	 * prompt preflight 里隐性长压缩」的缝隙，压缩耗时叠加 prompt RPC 超时导致误报启动失败。
	 * 压缩失败不阻断发送（退回现状，让原消息走正常错误渲染）。
	 */
	private async _autoCompactIfNeeded(
		sessionId: string,
		handle: SessionHandle,
	): Promise<void> {
		try {
			// 读当前上下文水位（pi get_session_stats.contextUsage：{ tokens, contextWindow, percent }），
			// 与 pi 内部压缩判断同源。此前经 pi-ai 模型目录查窗口：用户自定义模型（自填 baseUrl 的
			// 中转）不在目录里 → 预压缩静默失效，pi 在 prompt preflight 里的隐性压缩成为唯一防线，
			// 慢模型大会话下压缩耗时超 prompt RPC 60s 超时，被误报为「agent 启动失败: RPC 命令超时」。
			const stats = await handle.client.getSessionStats();
			const cu = stats?.contextUsage;
			if (!cu || typeof cu !== "object") return;
			// tokens 为 null（压缩边界后尚无新 assistant usage）时跳过：此刻上下文刚压完必然很小，
			// pi 侧防重压检查也不会触发，与 pi 判断一致
			const used = (cu as any).tokens ?? (cu as any).used;
			if (typeof used !== "number" || used <= 0) return;
			const windowFromPi = (cu as any).contextWindow;
			if (typeof windowFromPi !== "number" || windowFromPi <= 0) return;

			// 判断是否超限：占用超窗口比例阈值
			if (!shouldCompactBeforeSend(used, windowFromPi)) return;

			// 自动 compact（busy 防并发；compact RPC 超时 10 分钟；完成后由 _sendPromptNow 继续设 busy 发 prompt）
			console.log(
				`[kernel] session ${sessionId} 自动压缩：used=${used}(${(
					(used / windowFromPi) * 100
				).toFixed(
					1,
				)}% > ${(AUTO_COMPACT_USAGE_RATIO * 100).toFixed(0)}%) > contextWindow=${windowFromPi}`,
			);
			handle.busy = true;
			try {
				await handle.client.compact();
			} finally {
				handle.busy = false;
			}
			console.log(`[kernel] session ${sessionId} 自动压缩完成`);
		} catch (err) {
			console.error(
				`[kernel] session ${sessionId} 自动压缩失败（继续发送）:`,
				err,
			);
		}
	}

	/** 推送本地队列快照给前端（补充 pi queue_update 缺失的 followUpList） */
	private _emitLocalQueueUpdate(sessionId: string, handle: SessionHandle): void {
		this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
			type: "queue_update",
			steering: [...handle.steerList],
			followUp: handle.followUpList.map((e) => e.text),
		});
	}

	/** 发送用户输入。agent 运行中时进本地排队列表；空闲时直接 prompt。 */
	async prompt(
		sessionId: string,
		text: string,
		opts?: {
			model?: string;
			thinking?: ThinkingLevel;
			attachments?: AttachmentRef[];
		},
	): Promise<void> {
		const handle = this.sessions.get(sessionId);
		if (!handle) throw new Error(`会话未启动: ${sessionId}`);

		// 所有消息必须跟随用户显式选择的模型，禁止回退到 agent config 或 pi 默认模型
		if (!opts?.model) {
			throw new Error("未选择模型，请先在模型选择器中选择一个模型");
		}

		// 按请求切换模型（"provider/modelId" 拆分；无 "/" 时经 get_available_models 解析）
		const { provider, modelId } = await this._resolveModel(
			handle.client,
			opts.model,
		);
		await handle.client.setModel(provider, modelId);
		// 记录主会话当前模型：子智能体「跟随主模型」（override/config model 为空）时透传
		handle.currentModel = `${provider}/${modelId}`;

		// 按请求切换 thinking level（disabled→off，max→xhigh，pi 侧不支持时自动降级）
		if (opts?.thinking) {
			await handle.client.setThinkingLevel(mapThinkingLevel(opts.thinking));
			handle.currentThinking = opts.thinking;
		}

		// 构建最终 prompt 文本：snippet 直接内联，文件统一用绝对路径 path: 引用（不依赖 cwd 解析），
		// 图片额外读取为 ImageContent（多模态），随 prompt 一起发给 pi。
		const { text: finalText, images } = await buildPromptContent(
			text,
			opts?.attachments ?? [],
		);

		if (handle.busy) {
			// agent 运行中 → 追加到本地排队列表（图片随文本一并排队，settled 后 drain）
			handle.followUpList.push({ text: finalText, images });
			this._emitLocalQueueUpdate(sessionId, handle);
			return;
		}
		// 空闲直发：消息越过了排队路径（未进入 followUpList）。但前端在 isRunning=true
		// 时可能已乐观把这条消息加入队列面板（busy 竞态——本函数多个 await 期间本轮已
		// agent_settled，busy 翻 false 导致走这里的直发）。这里补发 queue_update，让前端
		// 同步真实队列（该消息不在队列里），清掉乐观残留。
		await this._sendPromptNow(sessionId, handle, finalText, images);
		this._emitLocalQueueUpdate(sessionId, handle);
	}

	/** 发送引导消息。运行中优先调 pi steer()（mid-loop 投递），同时存本地兜底 */
	async steerMessage(sessionId: string, text: string): Promise<void> {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;

		if (!handle.busy) {
			// 空闲直发（用户点「引导/立即」时 agent 已 settled）。
			// 先发送：成功了才从 followUpList 移除该条并广播 queue_update，
			// 避免发送失败时消息已出队（丢失）。必须与下方 busy 分支一致地从
			// followUpList 移除，否则后续 queue_update（如 drain/prompt/settled）
			// 会把它打回队列，前端乐观移除的第一条又恢复——「顶部的待引导消息没变化」。
			await this._sendPromptNow(sessionId, handle, text);
			const fi = handle.followUpList.findIndex((e) => e.text === text);
			if (fi >= 0) handle.followUpList.splice(fi, 1);
			this._emitLocalQueueUpdate(sessionId, handle);
			return;
		}

		// 同一会话同时只允许一条引导中：若 steerList 已有引导（busy 且有引导在流中），
		// 第二条引导消息不叠加，转入 followUpList 排队（agent_settled 时按顺序发送）。
		if (handle.steerList.length > 0) {
			if (!handle.followUpList.some((e) => e.text === text)) {
				handle.followUpList.push({ text });
			}
			this._emitLocalQueueUpdate(sessionId, handle);
			handle.lastActiveAt = Date.now();
			return;
		}

		// 双保险：pi steer() 尝试 mid-loop 投递 + 本地 steerList 兜底
		handle.steerList.push(text);
		// 如果该消息来自排队列表，则移除（避免 settled 时重复发送）
		const fi = handle.followUpList.findIndex((e) => e.text === text);
		if (fi >= 0) handle.followUpList.splice(fi, 1);
		this._emitLocalQueueUpdate(sessionId, handle);
		// 用户发送引导消息视为活跃，刷新空闲回收计时
		handle.lastActiveAt = Date.now();
		handle.client.steer(text).catch(() => {
			// steer 失败不丢消息——agent_settled 时 steerList 会兜底
		});
	}

	/** 中止当前会话：清空本地队列 + abort。 */
	async abort(sessionId: string): Promise<void> {
		const handle = this.sessions.get(sessionId);
		if (!handle) {
			if (this.starting.has(sessionId)) this.pendingAborts.add(sessionId);
			return;
		}

		askRegistry.cancelAll(sessionId);
		extUiRegistry.cancelAllForSession(sessionId); // 挂起的扩展对话一并作废
		handle.steerList = [];
		handle.followUpList = [];
		this._emitLocalQueueUpdate(sessionId, handle);
		// 级联中止在跑的子代理进程（delegate/fleet 派发时登记）：
		// 不中止的话主会话停了子代理仍跑到完成，成孤儿且结果无人消费。
		for (const c of handle.subagentAborts) c.abort();
		handle.subagentAborts.clear();
		console.log(`[agent-manager] abort session=${sessionId} busy=${handle.busy}`);
		const abortRpc = handle.client.abort().catch((err) => {
			console.error(`[agent-manager] abort 命令失败 session=${sessionId}:`, err);
		});
		// pi agent loop 卡死时（如实测等挂起的 LLM 响应）abort RPC 无人应答，
		// 停在这里用户永远停不下聊天——加超时兜底，超时强杀进程。
		const timeoutMs = this.opts.abortTimeoutMs ?? ABORT_RPC_TIMEOUT_MS;
		const timedOut = await Promise.race([
			abortRpc.then(() => false as const),
			new Promise<true>((r) => setTimeout(() => r(true), timeoutMs)),
		]);
		if (timedOut) {
			// 并发/重复 abort：会话已被先到的 abort 拆除则不再重复处理
			if (this.sessions.get(sessionId) !== handle) return;
			console.warn(
				`[agent-manager] abort 无响应（${timeoutMs}ms），强杀 pi 进程 session=${sessionId}`,
			);
			// 进程被强杀后 pi 不会再发任何 agent 事件：合成 message_end 错误（⚠️ 播报）
			// + agent_end（前端退出思考态），否则界面永远转圈。
			this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "agent 无响应，已强制停止（进程已终止），可重新发送消息",
					timestamp: Date.now(),
				},
			});
			this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
				type: "agent_end",
			});
			// 拆除进程与资源：会话记录与 jsonl 保留，下次使用时 ensureStarted 自动重建
			this._teardownSession(sessionId);
			return;
		}
		handle.busy = false;
		handle.thinkingSince = null;
		// abort RPC 成功返回时 pi 不一定广播 agent_settled（如 agent 已 idle 时
		// session.abort() 的 waitForIdle 立即返回，_emitAgentSettled 不触发）。
		// 前端退出思考态靠 agent_end/agent_settled 事件，此处合成 agent_end 兜底，
		// 否则停止成功后前端永远卡在「思考中」。超时强杀路径已在上方广播，此分支补。
		this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
			type: "agent_end",
		});
		console.log(`[agent-manager] abort DONE session=${sessionId}`);
	}

	/** 清空排队列表（不清 steerList，不 abort，不取消 ask） */
	clearFollowUpList(sessionId: string): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;
		handle.followUpList = [];
		this._emitLocalQueueUpdate(sessionId, handle);
	}

	/**
	 * 标记/清除会话的 transient 网络错误态。
	 * degraded=true 时，agent_settled 会跳过 followUp/steer drain（避免网络不可用时
	 * 自动发送排队消息再次失败），队列保留等用户重发恢复。
	 * degraded=false 在用户重发（_sendPromptNow）成功后自动清除，也可手动调用。
	 */
	markNetDegraded(sessionId: string, degraded: boolean): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;
		handle.netDegraded = degraded;
	}

	/** 读取会话历史消息快照（session 不存在时返回空数组） */
	getMessages(sessionId: string): any[] {
		return this.sessions.get(sessionId)?.messages ?? [];
	}

	/** 查询会话元信息（projectId/agentName）；未注册返回 undefined */
	getSessionMeta(
		sessionId: string,
	): { projectId: string; agentName: AgentName } | undefined {
		const h = this.sessions.get(sessionId);
		return h
			? { projectId: h.meta.projectId, agentName: h.meta.agentName }
			: undefined;
	}

	/** 检查 session 是否正在运行（供外部判断 abort 时 agent 是否已启动） */
	isSessionStreaming(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.busy ?? false;
	}

	/**
	 * 会话销毁时把子代理派发遥测追加到 WA_PI_DIR/subagent-telemetry.jsonl（fire-and-forget）。
	 *
	 * 正常路径：records 有内容 → 序列化每条记录 + session_summary → append 到 jsonl 文件。
	 *
	 * 边界情况：
	 *
	 * 1.【无记录时不落盘】records.length === 0 → 直接返回，不写入文件也不打印日志。
	 *    避免在 subagent-telemetry.jsonl 中产生空行或仅含 session_summary 的无效条目。
	 *    常见场景：从未派发过子代理的会话销毁时。
	 *
	 * 2.【异常状态仍落盘】records 有值但 summary.spawnCount === 0 时仍然序列化落盘，
	 *    不丢弃已收集的记录，保留调试线索。
	 *
	 * 3.【落盘失败静默吞错】appendFile 的 catch 为空函数，不阻塞会话拆除流程。
	 *
	 * 4.【快照非引用锁定】records 数组取的是调用瞬间的快照（const records），
	 *    不持有与 SubagentTelemetry 内部的引用锁——后续并发修改不影响已序列化的 lines。
	 *
	 * 5.【无记录时不打日志】空会话快速销毁时避免日志行泛滥。
	 */
	private _flushSubagentTelemetry(
		sessionId: string,
		handle: SessionHandle,
	): void {
		const records = handle.subagentTelemetry.records;
		// ── 边界：无记录时不落盘 ──
		// 没有派发过子代理的会话销毁时 records 为空。此时直接返回，不写入文件也不打印日志，
		// 避免在 subagent-telemetry.jsonl 中产生空行或仅含 session_summary 的无效条目。
		if (records.length === 0) return;
		const summary = handle.subagentTelemetry.summary;
		const lines = [
			...records.map((r) => JSON.stringify({ sessionId, ...r })),
			JSON.stringify({
				type: "session_summary",
				sessionId,
				ts: new Date().toISOString(),
				...summary,
			}),
		];
		console.log(
			`[telemetry] session ${sessionId.slice(0, 8)}: ${summary.spawnCount} 次派发，` +
				`成功率 ${(summary.successRate * 100).toFixed(0)}%，` +
				`估计节省父上下文 ${summary.totalSavingsTokensEst} tokens，` +
				`压缩率 ${summary.aggregateCompressionRatio.toFixed(2)}`,
		);
		void appendFile(
			join(WA_PI_DIR, "subagent-telemetry.jsonl"),
			lines.join("\n") + "\n",
			"utf8",
		).catch(() => {});
	}

	/** 拆除单个会话的内部资源（注销 bridge ctx + kill 进程 + 清临时文件与各 Map），不动 disposed 标记 */
	private _teardownSession(sessionId: string): void {
		// browser_* 视图随会话销毁（防浏览器进程泄漏）
		this.browserManager.closeSession(sessionId);
		askRegistry.cancelAll(sessionId); // 拆除资源时作废 pending ask
		// 挂起的扩展对话必须以 cancelled 解决：否则 rpc-client 的 handleUiRequest
		// 永远不返回（进程已死无实际阻塞，但 registry 条目会泄漏）
		extUiRegistry.cancelAllForSession(sessionId);
		unregisterBridgeSession(sessionId);
		const handle = this.sessions.get(sessionId);
		if (handle) {
			handle.disposed = true;
			this._flushSubagentTelemetry(sessionId, handle);
			// 拆除会话时级联中止在跑的子代理进程（防孤儿泄漏）
			for (const c of handle.subagentAborts) c.abort();
			handle.subagentAborts.clear();
			// dispose 是异步 kill，fire-and-forget（调用方多为同步拆除路径）
			void handle.client.dispose().catch(() => {});
			if (handle.promptFile) {
				void rm(handle.promptFile, { force: true }).catch(() => {});
			}
			if (handle.memorySnapshotFile) {
				void rm(handle.memorySnapshotFile, { force: true }).catch(() => {});
			}
		}
		this.sessions.delete(sessionId);
		this.dirty.delete(sessionId);
		this.skillDirty.delete(sessionId);
	}

	/**
	 * 查询会话是否正在处理中（agent_start 后 agent_settled 前）。
	 * @deprecated 仅保留为公开 API 兼容；GET /messages 的 isActive 请用
	 * isSessionActive（含冷启动 + prompt 排队语义）。本方法只查 handle.busy，
	 * 冷启动 + prompt 排队时返回 false 但 isActive 应为 true。
	 */
	isSessionBusy(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.busy === true;
	}

	/**
	 * 判断会话对 GET /messages 应报告的 isActive。
	 * - 真正在处理中（handle.busy，agent_start 后 agent_settled 前）→ true
	 * - 冷启动中且 prompt 排队中（新建会话发送消息，等待 pi 进程就绪后即将 prompt）→ true
	 * - 冷启动中但无 prompt 排队（getCommands / prewarm 预热，打开历史会话仅查看）→ false
	 * - 会话已预热（handle 存在）但 prompt 排队中（_promptLocks 已 set、prompt() 尚未调用）：
	 *   starting.has=false 且 handle.busy=false → false；该窗口极短（锁内 I/O 后同微任务
	 *   批次调用 prompt），与 da7acb15 之前行为一致，无回归。
	 *
	 * 不能仅用 starting.has 判 busy：冷启动被多种场景共用，打开历史会话时
	 * getCommands 也会触发 ensureStarted，若视为 busy，前端 setActiveStatus(true)
	 * 会把 idle 会话误标 thinking 且无 agent 事件复位（一直转圈）——回归自 da7acb15。
	 */
	isSessionActive(sessionId: string, promptQueued: boolean): boolean {
		const handle = this.sessions.get(sessionId);
		if (handle?.busy === true) return true;
		return this.starting.has(sessionId) && promptQueued;
	}

	/** 查询会话开始处理的时间戳，用于前端恢复思考计时 */
	getThinkingSince(sessionId: string): number | null {
		return this.sessions.get(sessionId)?.thinkingSince ?? null;
	}

	/**
	 * 获取会话 token 统计（pi get_session_stats 官方口径：全会话累计 + 当前上下文占用）。
	 * 仅当该会话已有存活 pi 进程时返回官方统计；无进程或查询失败返回 undefined，
	 * 调用方（ws-server session:stats）应降级为本地 jsonl 全量累计（computeSessionUsage）。
	 */
	async getSessionStats(sessionId: string): Promise<any | undefined> {
		const handle = this.sessions.get(sessionId);
		if (!handle?.client?.isAlive()) return undefined;
		try {
			return await handle.client.getSessionStats();
		} catch {
			return undefined;
		}
	}

	/** 会话 pi 进程是否存活（供预热前判断冷/热，决定是否广播 session:activated） */
	isSessionAlive(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.client?.isAlive() ?? false;
	}

	/** 重载当前会话配置：杀旧 pi 进程并用同一 agent 重建（技能/扩展变更生效） */
	async reloadSession(sessionId: string): Promise<void> {
		const handle = this.sessions.get(sessionId);
		// 无活跃进程（如只浏览历史未发消息）：先冷启动再重建
		if (!handle) {
			const { sessions } = await this.opts.projectStore.load();
			const se = sessions.find((s) => s.id === sessionId);
			if (!se) throw new Error(`会话不存在: ${sessionId}`);
			await this.ensureStarted(se.projectId, se.primaryAgent, sessionId);
		}
		const h = this.sessions.get(sessionId);
		if (!h) throw new Error(`会话启动失败: ${sessionId}`);
		await this.switchAgent(sessionId, h.meta.agentName);
	}

	/**
	 * 拉取当前会话可用的 slash 命令清单（来自 pi 运行时 get_commands）。
	 * 冷启动守卫同 reloadSession：无活跃进程时先 ensureStarted。
	 *
	 * 新会话页面场景：session 尚未在后端创建。此时不创建新 session（避免孤儿进程），
	 * 而是借用同 agent 已有活跃 session 的 pi 进程实时拉取命令（不缓存）。
	 * 若同 agent 无任何活跃进程，返回空数组——用户发送第一条消息后 session 被创建，
	 * 下次 / 菜单即会显示插件命令。
	 */
	async getCommands(
		sessionId: string,
		projectId?: string,
		agentName?: string,
	): Promise<CommandInfo[]> {
		// 1. 当前 session 已有活跃进程 → 直接取；dirty（扩展/技能变更待重建）则先重建再取，
		// 否则安装插件后 / 菜单与「附加命令」弹窗拿到的仍是旧进程的过期清单
		const handle = this.sessions.get(sessionId);
		if (handle?.client.isAlive()) {
			const h = await this._reloadIfDirty(sessionId, handle);
			return this._fetchCommands(h.client);
		}

		// 2. 当前 session 存在但进程未启动 → ensureStarted 后取
		const { sessions } = await this.opts.projectStore.load();
		const se = sessions.find((s) => s.id === sessionId);
		if (se) {
			await this.ensureStarted(se.projectId, se.primaryAgent, sessionId);
			const h = this.sessions.get(sessionId);
			if (h?.client.isAlive()) {
				return this._fetchCommands(h.client);
			}
			return [];
		}

		// 3. session 不存在（新会话页面）：借用任意活跃进程。
		// 跳过 dirty 进程（清单已过期）；无干净进程可借时重建首个空闲 dirty 进程再取。
		let dirtyCandidate: { id: string; handle: SessionHandle } | undefined;
		for (const [id, h] of this.sessions) {
			if (!h.client.isAlive()) continue;
			if (this.dirty.has(id) || this.skillDirty.has(id)) {
				dirtyCandidate ??= { id, handle: h };
				continue;
			}
			return this._fetchCommands(h.client);
		}
		if (dirtyCandidate && !dirtyCandidate.handle.busy) {
			const h = await this._reloadIfDirty(
				dirtyCandidate.id,
				dirtyCandidate.handle,
			);
			if (h.client.isAlive()) {
				return this._fetchCommands(h.client);
			}
		}

		// 4. 无进程可借但有 projectId+agentName：创建 session + 启动 pi 进程
		if (projectId && agentName) {
			// 默认工作区需要先创建 workdir 子目录（与 agent:prompt 行为一致）
			let createdAt: number | undefined;
			if (projectId === SYSTEM_PROJECT_ID) {
				createdAt = Date.now();
				await mkdir(join(SYSTEM_PROJECT_CWD, String(createdAt)), {
					recursive: true,
				});
			}
			await this.opts.projectStore.createSession({
				projectId,
				primaryAgent: agentName as AgentName,
				id: sessionId,
				// 兜底创建时还没有用户消息文本，留空占位；
				// 后续 agent:prompt 首次发送时会用消息内容填充标题。
				// placeholder 标记使该记录不进侧栏（loadActive 过滤），避免用户
				// 未发送就离开时留下「莫名其妙的空会话」；首次发消息时转正。
				title: "",
				createdAt,
				placeholder: true,
			});
			await this.ensureStarted(projectId, agentName as AgentName, sessionId);
			const h = this.sessions.get(sessionId);
			if (h?.client.isAlive()) {
				return this._fetchCommands(h.client);
			}
		}

		return [];
	}

	/**
	 * 从 pi 进程拉取命令清单：附加 packageName、合并插件开关状态后返回（不缓存）。
	 * enabled 合并对齐 extension:commands:list 的语义（kernel 侧统一，/ 菜单与插件页一致）：
	 * 有 packageName（extension 来源）→ 用 waPiCommandToggles 值（缺省 true：附加命令默认全部开启）；
	 * 无 packageName（prompt/builtin 等）→ 不附加 enabled（kernel 不填 → undefined，前端缺省 false）。
	 * 无 extensionManager（测试等场景）→ 保持原样。
	 */
	private async _fetchCommands(client: RpcClient): Promise<CommandInfo[]> {
		const { commands } = await client.getCommands();
		const cmds = attachPackageName((commands ?? []) as RawCommandInfo[]);
		if (!this.opts.extensionManager) return cmds;
		const toggles = await this.opts.extensionManager.getCommandToggles();
		return cmds.map((cmd) =>
			cmd.packageName
				? { ...cmd, enabled: toggles[cmd.packageName]?.[cmd.name] ?? true }
				: cmd,
		);
	}

	/** 清理单个会话：标记 disposed（防创建中被复用）+ 拆除资源 */
	async disposeSession(sessionId: string): Promise<void> {
		// 标记已被 dispose：若创建仍在进行中，_createSession 完成时会据此清理并放弃
		this.disposed.add(sessionId);
		this._teardownSession(sessionId);
	}

	/** 清理所有会话（进程退出 / 测试 teardown 用） */
	async disposeAll(): Promise<void> {
		// 复制 keys 避免 disposeSession 修改 Map 时迭代异常
		for (const id of [...this.sessions.keys()]) {
			await this.disposeSession(id);
		}
		// 全部会话销毁后停掉浏览器视图池（关掉 sweep 定时器与全部 WebView）
		this.browserManager.dispose();
	}

	/**
	 * 回收空闲会话的子进程：lastActiveAt 超过阈值且非 busy 的会话调 disposeSession。
	 * busy 会话跳过（_teardownSession 不检查 busy、不先 abort，强杀会丢失正在跑的工具/
	 * 排队消息），留待 agent_settled 后下一轮回收。dispose 只杀进程、保留会话记录与 jsonl
	 * 历史，用户再点开时 ensureStarted 从 jsonl 冷启动恢复。
	 * 返回被回收的 sessionId 列表，供调用方记日志。
	 */
	async reapIdleSessions(thresholdMs: number = 60 * 1000): Promise<string[]> {
		const now = Date.now();
		const reaped: string[] = [];
		// 复制 keys：disposeSession 会改 sessions Map，避免迭代异常
		for (const id of [...this.sessions.keys()]) {
			const handle = this.sessions.get(id);
			if (!handle) continue;
			// 正在思考/跑工具的会话绝不回收，留到下一轮
			if (handle.busy) continue;
			if (now - handle.lastActiveAt > thresholdMs) {
				await this.disposeSession(id);
				reaped.push(id);
			}
		}
		return reaped;
	}

	/**
	 * 把模型字符串解析成 provider + modelId。
	 * 常规形式 "provider/modelId"（按第一个 "/" 拆分，modelId 允许含 "/"）。
	 * 无 "/" 时经 pi 的 get_available_models 模糊匹配（兼容旧数据里的裸 modelId）。
	 */
	private async _resolveModel(
		client: RpcClient,
		pattern: string,
	): Promise<{ provider: string; modelId: string }> {
		const slash = pattern.indexOf("/");
		if (slash > 0) {
			return {
				provider: pattern.slice(0, slash),
				modelId: pattern.slice(slash + 1),
			};
		}
		try {
			const data = await client.command({ type: "get_available_models" });
			const models: Array<{ id: string; provider: string }> = data?.models ?? [];
			const exact = models.find((m) => m.id === pattern);
			if (exact) return { provider: exact.provider, modelId: exact.id };
			const ci = models.find((m) => m.id.toLowerCase() === pattern.toLowerCase());
			if (ci) return { provider: ci.provider, modelId: ci.id };
		} catch {
			/* 查询失败走下面的错误 */
		}
		throw new Error(`模型解析失败 (${pattern}): 请使用 "provider/modelId" 形式`);
	}
}

/** thinking level 映射：disabled→off，max→xhigh，其余透传（pi 侧不支持时自动降级） */
function mapThinkingLevel(thinking: string): string {
	return thinking === "disabled"
		? "off"
		: thinking === "max"
			? "xhigh"
			: thinking;
}

/** pi RPC prompt 命令的图片内容块（与 @earendil-works/pi-ai ImageContent 同形）。
 *  data 为 base64，pi 侧会组装为 user content 的 image part 并转成
 *  { type: "image_url", image_url: { url: "data:<mimeType>;base64,<data>" } }。 */
export interface ImageContent {
	type: "image";
	mimeType: string;
	data: string;
}

/** 支持内联发送的图片扩展名 → mime 映射（与 pi detectSupportedImageMimeTypeFromFile 对齐） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	ico: "image/x-icon",
};

/** 原始图片字节上限：单张超出则跳过内联（仅保留 @路径 文本引用）。
 *  3.5MB 原始 ≈ 4.67MB base64，对齐业界最严的 Anthropic 5MB base64 限制（pi 生态用 4.5MB 留余量）。 */
const MAX_IMAGE_INLINE_BYTES = 3.5 * 1024 * 1024;

/** 单次请求图片累计字节上限：超出部分回退为附件（@路径 引用），避免 RPC payload 过大（≈10MB base64 13.3MB）。 */
const MAX_TOTAL_IMAGE_INLINE_BYTES = 10 * 1024 * 1024;

/** 压缩目标的图片字节上限：超过单张上限的图尝试用 bun:image 压缩到 ≤ 此值再内联（对应「大图压到 3M 一张」需求）。 */
const MAX_IMAGE_COMPRESS_BYTES = 3 * 1024 * 1024;

/** 压缩尝试的原始图片大小上限：超过此值不压缩（超大图压缩无谓消耗 CPU）、直接降级为附件。 */
const MAX_IMAGE_COMPRESS_SOURCE_BYTES = 30 * 1024 * 1024;

/**
 * 用 bun:image 把图片压缩到 ≤ targetBytes（原始字节）。
 * 策略：缩尺寸优先——视觉模型通常把输入图缩到 ~1024px 处理，发送超过 4K 的分辨率
 * 既慢也无增益。因此先把宽缩小到 ≤ MAX_COMPRESS_TARGET_WIDTH，再 webp 编码（质量 85）。
 * 若仍超目标，逐级降质量 + 进一步缩小（每次 ×0.7），最多 MAX_COMPRESS_ITERATIONS 轮。
 * 失败（非位图/解码失败/始终超标）返回 null。只对 byte 级位图有效；
 * svg/ico 等矢量/图标不适合 webp 压缩，由调用方前置排除。
 */
async function compressImageToSize(
	buf: Uint8Array,
	targetBytes: number,
): Promise<{ content: ImageContent; bytes: number } | null> {
	const MAX_COMPRESS_ITERATIONS = 6; // 最多 6 轮（质量 + 缩尺寸），保证收敛不卡死
	const MAX_COMPRESS_TARGET_WIDTH = 4096; // 压缩后最大宽度：压倒 4K 内（视觉识别绰绰有余）；超过编码既慢又无增益
	const qualities = [85, 70, 60];
	let image: Bun.Image;
	try {
		image = new Bun.Image(buf);
	} catch {
		return null;
	}
	// 每轮都先缩到 ≤ MAX_COMPRESS_TARGET_WIDTH，再 webp 编码——对原始大图直接 webp
	// 编码既慢且体积常超标（视觉模型通常把图缩到 ~1024px 处理，发 4K 已足够）。
	// 注意 Bun.Image 是链式 pipeline：resize()/webp() 返回同一对象，bytes()/metadata() 才是 await terminal。
	let w: number;
	try {
		const meta = await image.metadata();
		w = meta.width;
	} catch {
		return null;
	}
	let scale = 1;
	for (let i = 0; i < MAX_COMPRESS_ITERATIONS; i++) {
		const quality = qualities[Math.min(i, qualities.length - 1)];
		// 第 0 轮缩到 min(原宽, 4096)，后续轮按 scale 等比缩小（每次 ×0.7），fit inside 不拉伸
		const targetW = Math.max(
			1,
			Math.round(Math.min(w, MAX_COMPRESS_TARGET_WIDTH) * scale),
		);
		try {
			const out = await image
				.resize(targetW, 66, { fit: "inside", withoutEnlargement: true })
				.webp({ quality })
				.bytes();
			if (out.length <= targetBytes) {
				return {
					content: {
						type: "image",
						mimeType: "image/webp",
						data: Buffer.from(out).toString("base64"),
					},
					bytes: out.length,
				};
			}
		} catch {
			return null;
		}
		scale *= 0.7;
	}
	return null;
}

/** 读取图片文件并转为 pi ImageContent（base64）。非图片扩展名/读取失败/超大时返回 null，不阻塞发送。
 *  maxBytes 为单张允许的最大原始字节数（调用方取「单张上限」与「累计剩余预算」的较小值）。
 *  超过单张上限但 ≤ 30MB 的图先尝试压缩到 ≤ maxBytes（webp）再内联；压缩失败/超 30MB/预算过小则降级为附件。 */
async function readImageContent(
	path: string,
	maxBytes: number,
): Promise<{ content: ImageContent; bytes: number } | null> {
	try {
		const st = await stat(path);
		if (!st.isFile() || st.size <= 0) {
			return null;
		}
		const ext = extname(path).slice(1).toLowerCase();
		const mimeType = IMAGE_MIME_BY_EXT[ext];
		if (!mimeType) return null;
		const buf = await readFile(path);
		// 源大小在允许范围内 → 直接内联（现状不变）
		if (st.size <= maxBytes) {
			return {
				content: { type: "image", mimeType, data: buf.toString("base64") },
				bytes: st.size,
			};
		}
		// 超单张上限：仅对位图（png/jpg/jpeg/gif/webp/bmp）尝试压缩；svg/ico 为矢量/图标不压缩。
		// 源大小 ≤ 30MB 且 maxBytes ≥ 1MB（预算过小强行压缩会毁图）才值得压缩。
		if (
			st.size <= MAX_IMAGE_COMPRESS_SOURCE_BYTES &&
			maxBytes >= 1 * 1024 * 1024 &&
			mimeType !== "image/svg+xml" &&
			mimeType !== "image/x-icon"
		) {
			const compressed = await compressImageToSize(
				buf,
				Math.min(maxBytes, MAX_IMAGE_COMPRESS_BYTES),
			);
			if (compressed) return compressed;
		}
		// 压缩失败或不应压缩 → 降级为附件（返回 null，文本保留 @路径 引用）
		return null;
	} catch {
		return null;
	}
}

/** 构建 prompt 最终文本。snippet 直接内联；文件统一用绝对路径 path: 引用（不依赖 cwd 解析）；图片额外读取为 ImageContent 供多模态发送。 */
interface PromptContent {
	text: string;
	images: ImageContent[];
}

async function buildPromptContent(
	text: string,
	attachments: AttachmentRef[],
): Promise<PromptContent> {
	const textParts: string[] = [];
	const fileRefs: string[] = [];
	const images: ImageContent[] = [];
	let usedBytes = 0; // 已内联图片累计原始字节数（预算控制）

	for (const a of attachments) {
		if (a.kind === "snippet") {
			textParts.push(`[片段: ${a.name}]\n${a.content}`);
		} else if (a.kind === "image") {
			const ref = a.path.replace(/\\/g, "/");
			fileRefs.push(`path:${ref}`);
			// 图片同时作为多模态 content part 发给 pi：
			// - 单张超过 MAX_IMAGE_INLINE_BYTES（对齐业界最严 Anthropic 5MB base64）→ 不内联
			// - 累计超过 MAX_TOTAL_IMAGE_INLINE_BYTES → 超出部分不内联
			// - 读取失败/非图片扩展名 → 不内联
			// 以上均降级为纯文本 @路径 引用，不阻塞发送。
			const remaining = MAX_TOTAL_IMAGE_INLINE_BYTES - usedBytes;
			if (remaining > 0) {
				const img = await readImageContent(
					a.path,
					Math.min(MAX_IMAGE_INLINE_BYTES, remaining),
				);
				if (img) {
					images.push(img.content);
					usedBytes += img.bytes;
				}
			}
		} else {
			const ref = a.path.replace(/\\/g, "/");
			fileRefs.push(`path:${ref}`);
		}
	}

	textParts.push(text);

	if (fileRefs.length > 0) {
		const refsText = `[${fileRefs.join(",\n")}]`;
		textParts.push(`Attachments:\n${refsText}`);
	}

	return { text: textParts.join("\n\n"), images };
}

/**
 * 构造注入系统提示词的记忆快照：全局 memory+user，叠加项目 memory+user。
 * 返回 amaster 已做 promptware 清洗的冻结快照；无任何记忆时返回空串。
 * 只读——agent 写记忆走 bridge 回调的记忆工具，全局记忆由用户经 UI 维护。
 */
async function buildMemorySnapshot(
	waPiDir: string,
	projectCwd: string,
): Promise<string> {
	const parts: string[] = [];
	const globalSnap = await getGlobalMemoryStore(waPiDir).snapshotAll();
	if (globalSnap) parts.push(globalSnap);
	const projectSnap = await getProjectMemoryStore(
		waPiDir,
		projectCwd,
	).snapshotAll();
	if (projectSnap) parts.push(projectSnap);
	return parts.join("\n\n");
}

/**
 * 解析所有已启用的技能（含内置、userDirs、扩展包）。
 * Pi SDK 默认扫描已关闭（--no-skills），所以必须显式传入所有要加载的技能路径。
 * skillManager 为空（测试场景）时返回空数组。
 */
async function resolveEnabledSkills(
	skillManager: SkillManager | undefined,
	extensionManager?: ExtensionManager,
): Promise<SkillInfo[]> {
	if (!skillManager) return [];

	// 获取扩展技能路径（可能为空）
	const extSkillPaths = extensionManager
		? await extensionManager.getEnabledExtensionSkillPaths()
		: [];

	// scan 已按 builtin → userDirs → ext 顺序去重并过滤 disabledSkills
	const { skills } = await skillManager.scan(extSkillPaths);

	return skills;
}
