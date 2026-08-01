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
//   （config.tools ∪ EXTENSION_TOOL_MAP ∪ MCP direct 工具名）。
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
	EXTENSION_TOOL_MAP,
	resolveAgentTools,
	resolveSessionCwd,
	PROMPTS_FILE,
	SUBAGENT_TYPES,
	isSubagentType,
	SYSTEM_PROJECT_ID,
	SYSTEM_PROJECT_CWD,
} from "@wa-pi/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import type { ProviderStore } from "./provider-store";
import { relative, join } from "node:path";
import { mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildAdditionalExtensionPaths } from "./extensions";
import {
	filterTuiCommands,
	isTuiOnlyCommand,
	type RawCommandInfo,
} from "./tui-command-filter";
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
} from "./provider-extension";
import { SubagentTelemetry } from "./subagent-telemetry";
import type { WaPiSpawnConfig } from "./subagent-runner";
import { seedBuiltinAgents } from "./builtin-agents";
import { readBuiltinAgentPrompt } from "./subagent-info";
import { askRegistry } from "./ask-registry";
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
	type RpcClientOpts,
	type RpcEvent,
} from "./rpc-client";
import {
	composePrompt,
	loadPromptSegments,
	DEFAULT_PROMPT_SEGMENTS,
	DEFAULT_MEMORY_POLICY_PROMPT,
	COMPACT_MEMORY_POLICY_PROMPT,
	WA_PI_DEFAULT_BASE_PROMPT,
	type PromptSegment,
} from "./system-prompt";

/** 可注入的 client 工厂（测试用假 client 替换；生产 new RpcClient） */
export type CreateClientFn = (opts: RpcClientOpts) => RpcClient;

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
	// 测试注入 mock；生产留空 → 真实 RpcClient
	createClientFn?: CreateClientFn;
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

/** 单个会话的运行时句柄 */
interface SessionHandle {
	client: RpcClient;
	cwd: string;
	meta: { projectId: string; agentName: AgentName };
	/** agent 是否忙碌（prompt 发送后置 true，agent_settled 置 false） */
	busy: boolean;
	/** agent_start 的时间戳（ms），用于前端恢复思考计时 */
	thinkingSince: number | null;
	/** 历史消息快照（创建时经 get_messages 拉取 + message_end 增量追加） */
	messages: any[];
	/** 排队消息列表（agent_settled 时逐条 drain） */
	followUpList: string[];
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
	/** 主会话当前模型（"provider/modelId"）：子智能体「跟随主模型」时透传给 spawn --model */
	currentModel: string | null;
	/** 主会话当前 thinking level（prompt 时记录），子智能体「跟随主配置」时透传 */
	currentThinking: ThinkingLevel | null;
	/** transient 网络错误标记：true 时 agent_settled 跳过 followUp/steer drain，
	 *  避免网络不可用时自动发送排队消息（会再失败）。用户重发后清除。 */
	netDegraded: boolean;
	/** 最近一次活跃时间戳（ms）：prompt / message_end / steer / 打开会话时刷新。
	 *  供 reapIdleSessions 判断是否回收该会话子进程，避免每轮读盘。 */
	lastActiveAt: number;
}

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

	constructor(private opts: AgentManagerOpts) {}

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
		this.promptSegments = loaded ?? DEFAULT_PROMPT_SEGMENTS;
		return this.promptSegments;
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
	): Promise<SessionHandle> {
		// 命中缓存：进程已崩溃则拆除重建；否则按 dirty 标记决定重建或直接复用
		const existing = this.sessions.get(sessionId);
		if (existing) {
			if (existing.crashed || !existing.client.isAlive()) {
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

		const promise = this._createSession(projectId, agentName, sessionId);
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
		this._commandsCache = null;
	}

	/**
	 * 标记当前所有活跃会话为待重建（skill 目录增删 / skill 禁用后调用）。
	 * 与 markAllDirty 统一为进程重启（--skill 列表构造时固定，只能重启刷新）。
	 */
	markSkillsDirty(): void {
		for (const id of this.sessions.keys()) this.skillDirty.add(id);
		this._commandsCache = null;
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
		this._teardownSession(sessionId);
		const projectId =
			meta?.projectId ??
			(await this.opts.projectStore.load()).sessions.find(
				(s) => s.id === sessionId,
			)?.projectId;
		if (!projectId) throw new Error(`会话不存在: ${sessionId}`);
		await this.opts.projectStore.setSessionAgent(sessionId, agentName);
		const promise = this._createSession(projectId, agentName, sessionId);
		this.starting.set(sessionId, promise);
		try {
			await promise;
		} finally {
			this.starting.delete(sessionId);
		}
	}

	/**
	 * 读取当前启用的可选插件 id 集合，供 -e 扩展路径与工具放行过滤。
	 * 无 extensionManager 时返回空集（保持测试兼容）。
	 * 热路径用轻量方法：list() 会对每个启用包跑 bun pm ls + npm view（registry 网络请求）。
	 */
	private async getEnabledExtensionIds(): Promise<Set<string>> {
		if (!this.opts.extensionManager) return new Set();
		return new Set(await this.opts.extensionManager.listEnabledPackageNames());
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
	 *  source 值：内置 → "内置"，MCP direct → "MCP"，动态插件 → 插件包名。 */
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
		// 动态插件登记的工具（EXTENSION_TOOL_MAP 按启用态注入），source 用插件包名
		const enabledIds = await this.getEnabledExtensionIds();
		for (const [extId, extTools] of Object.entries(EXTENSION_TOOL_MAP)) {
			if (!enabledIds.has(extId)) continue;
			for (const t of extTools) {
				if (!seen.has(t) && t !== "subagent") {
					seen.add(t);
					items.push({ name: t, source: extId });
				}
			}
		}
		return items;
	}

	/**
	 * 命中缓存时：dirty 标记（skill / extension 配置变更）→ 重建进程；进行中则跳过等 idle。
	 */
	private async _reloadIfDirty(
		sessionId: string,
		handle: SessionHandle,
	): Promise<SessionHandle> {
		const isDirty = this.skillDirty.has(sessionId) || this.dirty.has(sessionId);
		if (!isDirty) return handle;
		if (handle.busy || handle.followUpList.length > 0) return handle; // 进行中，保留 dirty 等 idle

		this.skillDirty.delete(sessionId);
		this.dirty.delete(sessionId);
		// 重建：拆除旧进程（不动 disposed）+ 重新 _createSession（同一会话文件，历史不丢）。
		// 用 starting 锁防止重建期间并发 ensureStarted 重复创建。
		this._teardownSession(sessionId);
		const promise = this._createSession(
			handle.meta.projectId,
			handle.meta.agentName,
			sessionId,
		);
		this.starting.set(sessionId, promise);
		try {
			return await promise;
		} finally {
			this.starting.delete(sessionId);
		}
	}

	private async _createSession(
		projectId: string,
		agentName: AgentName,
		sessionId: string,
	): Promise<SessionHandle> {
		// 启动时写入内置 subagent 的 .md 定义文件（~/.wa-pi/agents/*.md），已存在不覆盖
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
		const enabledSkills = await resolveEnabledSkills(
			this.opts.skillManager,
			this.opts.extensionManager,
		);
		const additionalSkillPaths = (
			config?.skills?.length
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
			await Promise.all(
				askToNames.map((n) => this.opts.configStore!.getAgent(n)),
			)
		).filter((c): c is NonNullable<typeof c> => c != null);
		// 加载系统提示词段落配置（首次加载后缓存）
		const promptSegments = await this.getPromptSegments();
		const askToTargets = askToConfigs.map((c) => ({
			name: c.displayName,
			description: c.description,
			delegationHints: c.delegationHints,
		}));

		// resolveSpawnConfig：从 ConfigStore 读 WaPi 配置（用户在 UI 设置的 model/thinking/tools/skills），
		// 内置 subagent 类型不在 store 里——从 SUBAGENT_TYPES 常量读元信息 + ~/.wa-pi/agents/*.md 读系统提示词。
		const resolveSpawnConfig = async (
			agentName: string,
		): Promise<WaPiSpawnConfig | null> => {
			// 内置 subagent 类型：从 SUBAGENT_TYPES 元信息 + agents/*.md 读定义（用户可覆盖）
			if (isSubagentType(agentName)) {
				const builtin = SUBAGENT_TYPES.find((t) => t.name === agentName);
				if (builtin) {
					const prompt = await readBuiltinAgentPrompt(agentsDir, agentName);
					// 读取用户保存的 model/thinking 覆盖（~/.wa-pi/subagent-overrides.json）
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
						tools: builtin.readOnly
							? ["read", "bash", "grep", "find", "ls"]
							: [],
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
			};
		};

		// 会话级子代理遥测收集器：随 spawnFn 生命周期创建，_teardownSession 时 flush
		const subagentTelemetry = new SubagentTelemetry();
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

		const spawnFn = makeSpawnFn({
			resolveConfig: resolveSpawnConfig,
			extensionPaths: existsSync(providerExtPath) ? [providerExtPath] : [],
			// 派发前自愈：extension 文件可能与 providers.json 不同步（空壳/过时/手动改坏），
			// 导致子进程报 "No API key found"。按需重生，保证子进程加载到含所需 provider 的 extension。
			ensureExtension: this.opts.providerStore
				? async (requiredSlug?: string) => {
						// 无具体 slug（跟随主模型）或 extension 不含该 slug 时，重新生成
						if (
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

		// 内置 subagent 的委派引导从 ~/.wa-pi/agents/*.md 的 frontmatter 提取（与命名智能体统一来源）
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
				return defaultCtx.handleTool(tool, toolCallId, params, signal);
			},
		};

		// 组合系统提示词并写入临时文件（pi 的 --system-prompt 支持文件路径，规避命令行长度限制）。
		// 角色提示词（agent.md 正文 systemPromptBody）非空时替代默认 base 提示词。
		// 注意：prompts.json 的 base.content（用户全局覆盖）优先级最高——
		// renderSegment 里 segment.content 非空时直接使用，不看 defaultBasePrompt。
		const defaultBasePrompt = !config?.systemPromptBody
			? WA_PI_DEFAULT_BASE_PROMPT
			: config.systemPromptBody;
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
		//   内置 7 工具 + 扩展工具 + MCP direct 工具全部可用（对齐迁移前 DEFAULT+harvested 的行为）。
		// - 显式配置 tools：白名单——config.tools ∪ EXTENSION_TOOL_MAP ∪ MCP direct 工具名。
		const enabledExtensionIds = await this.getEnabledExtensionIds();

		// 当 agent 配置了 skills 白名单时，排除提供技能的 extension（如 superpowers-zh），
		// 避免 pi 的 -e + resources_discover 机制绕过白名单过滤。
		// extension skills 已通过 --skill 参数按白名单过滤传入。
		// 保留 wa-pi-bridge 等工具类 extension（提供 delegate/fleet/memory 工具）。
		const restrictedSkills = !!config?.skills?.length;
		const skillProvidingExtIds =
			restrictedSkills && this.opts.extensionManager
				? new Set(
						(
							await this.opts.extensionManager.getEnabledExtensionSkillPaths()
						).map((s) => s.packageName),
					)
				: new Set<string>();
		const extensionPaths = restrictedSkills
			? buildAdditionalExtensionPaths(
					[...enabledExtensionIds].filter(
						(id) => !skillProvidingExtIds.has(id),
					),
				)
			: buildAdditionalExtensionPaths([...enabledExtensionIds]);

		const restricted = !!config?.tools?.length;
		const toolArgs: { tools?: string[]; excludeTools?: string[] } = restricted
			? {
					tools: resolveAgentTools(
						config!.tools!,
						enabledExtensionIds,
						agentName,
						EXTENSION_TOOL_MAP,
						await this.getMcpDirectToolNames(),
					),
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
			client: null as unknown as RpcClient,
			cwd,
			meta: { projectId, agentName },
			busy: false,
			thinkingSince: null,
			messages: [],
			followUpList: [],
			steerList: [],
			promptFile,
			memorySnapshotFile: memorySnapshotFile ?? null,
			piSessionFile: sessionEntity.piSessionFile,
			crashed: false,
			disposed: false,
			subagentTelemetry,
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
			},
			onEvent: (e) => this._onSessionEvent(sessionId, e),
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
			console.error(`[kernel] session ${sessionId} 拉取历史消息失败:`, err);
			handle.messages = [];
		}

		// 如果创建过程中被 dispose，清理已提前注册的 handle
		if (this.disposed.has(sessionId)) {
			this.disposed.delete(sessionId);
			this._teardownSession(sessionId);
			throw new Error(`会话已清理: ${sessionId}`);
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
				break;
			case "message_end":
				if (event.message) handle.messages.push(event.message);
				// agent 回复完成视为活跃（与磁盘 touchSession 同步），刷新空闲回收计时
				handle.lastActiveAt = Date.now();
				break;
			case "agent_end": {
				// 整轮耗时：该轮最后 assistant.timestamp − user.timestamp（纯读推算语义，
				// 与 session-history 注入一致）。仅成功轮附加；失败回合/找不到 user 不附加。
				const msgs = (event as any).messages as any[] | undefined;
				if (Array.isArray(msgs)) {
					const lastAssistant = [...msgs]
						.reverse()
						.find((m: any) => m?.role === "assistant");
					const user = [...msgs].reverse().find((m: any) => m?.role === "user");
					if (lastAssistant && user && lastAssistant.stopReason !== "error") {
						(event as any).elapsedMs = lastAssistant.timestamp - user.timestamp;
					}
				}
				break;
			}
			case "agent_settled":
				handle.busy = false;
				handle.thinkingSince = null;
				handle.thinkingSince = null;
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
						console.error(
							`[kernel] session ${sessionId} steer drain 失败:`,
							err,
						);
					});
				} else if (handle.followUpList.length > 0) {
					// 无引导消息时才 drain 排队消息
					const text = handle.followUpList.shift()!;
					this._emitLocalQueueUpdate(sessionId, handle);
					void this._sendPromptNow(sessionId, handle, text).catch((err) => {
						console.error(
							`[kernel] session ${sessionId} followUp drain 失败:`,
							err,
						);
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
				followUp: [...handle.followUpList],
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
				.catch((e) =>
					console.error(`[kernel] 孤儿回滚删除失败 ${sessionId}:`, e),
				);
			this.opts.onSessionRollback?.(sessionId);
			return;
		}
		handle.crashed = true;
		handle.busy = false;
		handle.thinkingSince = null;
		console.error(
			`[kernel] session ${sessionId} pi 进程意外退出 (code=${code} signal=${signal ?? "none"})`,
		);
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

	/** 立即发送 prompt（busy 置位 + 失败回退） */
	private async _sendPromptNow(
		sessionId: string,
		handle: SessionHandle,
		text: string,
	): Promise<void> {
		handle.busy = true;
		// 用户重发触发直接 prompt：网络已恢复，清除 transient degraded 标记，恢复 drain。
		if (handle.netDegraded) handle.netDegraded = false;
		try {
			await handle.client.prompt(text);
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
				this.opts.onEvent(
					sessionId,
					handle.meta.projectId,
					handle.meta.agentName,
					{
						type: "agent_end",
					},
				);
			}
		}, 50);
	}

	/** 推送本地队列快照给前端（补充 pi queue_update 缺失的 followUpList） */
	private _emitLocalQueueUpdate(
		sessionId: string,
		handle: SessionHandle,
	): void {
		this.opts.onEvent(sessionId, handle.meta.projectId, handle.meta.agentName, {
			type: "queue_update",
			steering: [...handle.steerList],
			followUp: [...handle.followUpList],
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

		// TUI-only 命令（/ 菜单已屏蔽的）不交给 pi 命令分发：加前导空格让 pi
		// 按普通文本发给大模型（pi 只认 / 开头的文本为命令）。否则 handler 要么
		// 静默成功（前端什么都看不到），要么触发 RPC 不支持的 TUI 面板。
		// 命令清单未拉取过时先拉一次（结果有 5min 缓存，扫描结果复用）。
		if (text.startsWith("/")) {
			if (!this._commandsCache) {
				await this._fetchAndCacheCommands(handle.client).catch(() => []);
			}
			const sp = text.indexOf(" ");
			const cmdName = sp === -1 ? text.slice(1) : text.slice(1, sp);
			if (isTuiOnlyCommand(cmdName)) text = ` ${text}`;
		}

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

		// 构建最终 prompt 文本：snippet 直接内联，文件/图片统一用 @相对路径 引用
		const { text: finalText } = buildPromptContent(
			text,
			opts?.attachments ?? [],
			handle.cwd,
		);

		if (handle.busy) {
			// agent 运行中 → 追加到本地排队列表
			handle.followUpList.push(finalText);
			this._emitLocalQueueUpdate(sessionId, handle);
			return;
		}
		await this._sendPromptNow(sessionId, handle, finalText);
	}

	/** 发送引导消息。运行中优先调 pi steer()（mid-loop 投递），同时存本地兜底 */
	async steerMessage(sessionId: string, text: string): Promise<void> {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;

		if (!handle.busy) {
			await this._sendPromptNow(sessionId, handle, text);
			return;
		}

		// 双保险：pi steer() 尝试 mid-loop 投递 + 本地 steerList 兜底
		handle.steerList.push(text);
		// 如果该消息来自排队列表，则移除（避免 settled 时重复发送）
		const fi = handle.followUpList.indexOf(text);
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
		handle.steerList = [];
		handle.followUpList = [];
		this._emitLocalQueueUpdate(sessionId, handle);
		console.log(
			`[agent-manager] abort session=${sessionId} busy=${handle.busy}`,
		);
		await handle.client.abort().catch((err) => {
			console.error(
				`[agent-manager] abort 命令失败 session=${sessionId}:`,
				err,
			);
		});
		handle.busy = false;
		handle.thinkingSince = null;
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
		askRegistry.cancelAll(sessionId); // 拆除资源时作废 pending ask
		unregisterBridgeSession(sessionId);
		const handle = this.sessions.get(sessionId);
		if (handle) {
			handle.disposed = true;
			this._flushSubagentTelemetry(sessionId, handle);
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

	/** 查询会话是否正在处理中（agent_start 后 agent_settled 前） */
	isSessionBusy(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.busy === true;
	}

	/** 查询会话开始处理的时间戳，用于前端恢复思考计时 */
	getThinkingSince(sessionId: string): number | null {
		return this.sessions.get(sessionId)?.thinkingSince ?? null;
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
	 * 而是借用同 agent 已有活跃 session 的 pi 进程获取命令，结果缓存 5 分钟。
	 * 若同 agent 无任何活跃进程，返回空数组——用户发送第一条消息后 session 被创建，
	 * 下次 / 菜单即会显示插件命令。
	 */
	async getCommands(
		sessionId: string,
		projectId?: string,
		agentName?: string,
	): Promise<CommandInfo[]> {
		// 1. 查全局缓存（5min TTL，插件命令对所有 agent 一致）
		const cached = this._commandsCache;
		if (cached && Date.now() - cached.ts < 5 * 60_000) {
			return cached.commands;
		}

		// 2. 当前 session 已有活跃进程 → 直接取
		const handle = this.sessions.get(sessionId);
		if (handle?.client.isAlive()) {
			return this._fetchAndCacheCommands(handle.client);
		}

		// 3. 当前 session 存在但进程未启动 → ensureStarted 后取
		const { sessions } = await this.opts.projectStore.load();
		const se = sessions.find((s) => s.id === sessionId);
		if (se) {
			await this.ensureStarted(se.projectId, se.primaryAgent, sessionId);
			const h = this.sessions.get(sessionId);
			if (h?.client.isAlive()) {
				return this._fetchAndCacheCommands(h.client);
			}
			return [];
		}

		// 4. session 不存在（新会话页面）：借用任意活跃进程
		for (const [_, h] of this.sessions) {
			if (h.client.isAlive()) {
				return this._fetchAndCacheCommands(h.client);
			}
		}

		// 5. 无进程可借但有 projectId+agentName：创建 session + 启动 pi 进程
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
				// 后续 agent:prompt 首次发送时会用消息内容填充标题
				title: "",
				createdAt,
			});
			await this.ensureStarted(projectId, agentName as AgentName, sessionId);
			const h = this.sessions.get(sessionId);
			if (h?.client.isAlive()) {
				return this._fetchAndCacheCommands(h.client);
			}
		}

		return [];
	}

	/** 命令缓存（全局，插件命令对所有 agent 一致，5min TTL） */
	private _commandsCache: { commands: CommandInfo[]; ts: number } | null = null;

	/** 从 pi 进程拉取命令清单：过滤 TUI-only 命令（RPC 模式不可用）后写入缓存 */
	private async _fetchAndCacheCommands(
		client: RpcClient,
	): Promise<CommandInfo[]> {
		const { commands } = await client.getCommands();
		const cmds = filterTuiCommands((commands ?? []) as RawCommandInfo[]);
		this._commandsCache = { commands: cmds, ts: Date.now() };
		return cmds;
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
			const models: Array<{ id: string; provider: string }> =
				data?.models ?? [];
			const exact = models.find((m) => m.id === pattern);
			if (exact) return { provider: exact.provider, modelId: exact.id };
			const ci = models.find(
				(m) => m.id.toLowerCase() === pattern.toLowerCase(),
			);
			if (ci) return { provider: ci.provider, modelId: ci.id };
		} catch {
			/* 查询失败走下面的错误 */
		}
		throw new Error(
			`模型解析失败 (${pattern}): 请使用 "provider/modelId" 形式`,
		);
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

/** 构建 prompt 最终文本。snippet 直接内联；文件/图片统一用项目相对路径 @引用。 */
interface PromptContent {
	text: string;
}

function buildPromptContent(
	text: string,
	attachments: AttachmentRef[],
	cwd?: string,
): PromptContent {
	const textParts: string[] = [];
	const fileRefs: string[] = [];

	for (const a of attachments) {
		if (a.kind === "snippet") {
			textParts.push(`[片段: ${a.name}]\n${a.content}`);
		} else {
			const rel = cwd ? relative(cwd, a.path).replace(/\\/g, "/") : a.path;
			fileRefs.push(`@${rel}`);
		}
	}

	textParts.push(text);

	if (fileRefs.length > 0) {
		const refsText = `[${fileRefs.join(",\n")}]`;
		textParts.push(`Attachments:\n${refsText}`);
	}

	return { text: textParts.join("\n\n") };
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
