// WaPi 共享类型定义

import type {
	ProviderListEvent,
	ProviderSaveEvent,
	ProviderDeleteEvent,
	ProviderTestEvent,
	ProviderListResult,
	ProviderTestResult,
	ProviderChangedEvent,
	ModelPresetsRequest,
	ModelPresetsResult,
} from "./providers";
import type {
	SkillListEvent,
	SkillToggleEvent,
	SkillDirAddEvent,
	SkillDirRemoveEvent,
	SkillListResult,
	SkillChangedEvent,
} from "./skills";
import type {
	ExtensionListEvent,
	ExtensionToggleEvent,
	ExtensionInstallEvent,
	ExtensionUninstallEvent,
	ExtensionUpgradeEvent,
	ExtensionListResult,
	ExtensionChangedEvent,
	ExtensionErrorEvent,
	ExtensionProgressEvent,
	ExtensionInstallDoneEvent,
	ExtensionNotifyEvent,
	ExtensionCommandsListEvent,
	ExtensionCommandToggleEvent,
	ExtensionCommandsListResult,
	ExtensionCommandToggleResult,
	ExtensionCommandsChangedEvent,
} from "./extensions";
import type {
	MemoryListEvent,
	MemoryUpdateEvent,
	MemoryArchiveEvent,
	MemoryRestoreEvent,
	MemoryPurgeEvent,
	MemoryAddEvent,
	InstructionListEvent,
	MemoryConfigGetEvent,
	MemoryConfigSetEvent,
	MemoryListResult,
	MemoryChangedEvent,
	InstructionListResult,
	MemoryConfigEvent,
} from "./memory";
import type { AskReply } from "./ask";
import type {
	McpListEvent,
	McpSaveEvent,
	McpDeleteEvent,
	McpTestEvent,
	McpListToolsEvent,
	McpClearAuthEvent,
	McpListResult,
	McpChangedEvent,
	McpTestResult,
	McpToolsResult,
} from "./mcp";
import type { SessionCommandsRequest, SessionCommandsResult } from "./commands";

export type AgentName = string;
export type AgentStateKey = `${string}:${AgentName}`;
export type AgentStatus = "idle" | "thinking" | "blocked";

// Composer / Prompt 的思考强度档位（UI 选择器）
export type ThinkingLevel = "disabled" | "medium" | "high" | "max";

export interface Partners {
	askTo: AgentName[];
}

/** 委派引导：注入 delegate 工具描述，引导主智能体在合适场景调起本智能体 */
export interface DelegationHints {
	whenToDelegate?: string; // 何时调起本智能体
	whenNotTo?: string; // 何时不调起
	benefit?: string; // 调起收益
}

export interface AgentConfig {
	displayName: string; // 唯一标识符 + 展示名（文件名/会话外键/partners 引用均用此字段）
	avatar: string;
	avatarColor: string; // "hex-hex" 渐变
	description: string;
	model: string | null; // null / "" = 跟随全局
	thinking: ThinkingLevel | null; // null = 跟随当前会话默认
	tools: string[];
	skills: string[];
	mcpServers: string[];
	partners: Partners;
	delegationHints?: DelegationHints; // 委派引导：注入 delegate 工具描述
	systemPromptBody?: string; // frontmatter 后的正文
}

/** 内置 subagent 的用户级覆盖（model / thinking）。type = 内置 subagent 英文名。 */
export interface SubagentOverride {
	type: string;
	model?: string | null;
	thinking?: ThinkingLevel | null;
}

/** 内置 subagent 完整信息（前端 AgentConfig 展示用）。systemPrompt/builtinToolNames 来自 pi-subagents，只读。 */
export interface SubagentInfo {
	name: string;
	displayName: string;
	description: string;
	emoji: string;
	gradient: [string, string];
	readOnly: boolean;
	systemPrompt: string;
	builtinToolNames: string[];
	/** 委派引导：从 ~/.wa-pi/agents/*.md 的 frontmatter 提取，前端只读展示 */
	delegationHints?: DelegationHints;
	override?: SubagentOverride;
}

export interface ProjectEntity {
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
}

/** token 用量五项合计：session:stats 的主/子代理分解与会话记录持久化共用。 */
export interface TokenUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface SessionEntity {
	id: string;
	projectId: string;
	primaryAgent: AgentName;
	title: string;
	createdAt: number;
	lastActivity: number;
	piSessionFile: string; // SDK jsonl 文件路径 ~/.wa-pi/sessions/<id>.jsonl
}

// ===== Pi 原生消息类型（镜像 @mariozechner/pi-ai，避免运行时依赖）=====
// 说明：Pi 原生类型还带 textSignature/thinkingSignature/redacted/thoughtSignature
// 等签名/脱敏字段，前端渲染用不到，这里按"最小可渲染集"省略。

export interface TextContent {
	type: "text";
	text: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	model: string;
	stopReason: string;
	timestamp: number;
	// 运行时错误文案：SDK 把 provider 失败编码成 stopReason:"error" 的消息时携带。
	// kernel 读取它翻译成 {type:"error"} 广播给前端；前端渲染层不直接消费。
	errorMessage?: string;
	// 整轮耗时（ms）：本轮最后一条 assistant.timestamp − user.timestamp。
	// 仅成功完成的轮注入（失败回合/旧数据无此字段）。历史加载由 kernel 注入，
	// 实时轮由前端在 agent_end 时写回。渲染层据此显示「本轮时长」。
	turnElapsedMs?: number;
	// usage：透传 Pi SDK 的 Usage 对象。message_end 时由 kernel 原样转发到前端。
	// 旧消息无此字段，前端需兼容 undefined。cost 字段不在前端使用故不定义。
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
	};
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
	/** 工具执行的结构化附加信息（如 fleet 各子代理的工具调用统计）。
	 *  由 kernel 工具 execute 返回，经 pi SDK 原样持久化到会话 JSONL；
	 *  旧会话无此字段，前端需兼容 undefined。 */
	details?: unknown;
}

/** 子代理工具调用统计（总数/成功/失败/执行中），与 SubagentProgressEvent.tools 同源分桶 */
export interface ToolStats {
	total: number;
	done: number;
	error: number;
	running: number;
}

// Pi custom 消息（intercom / pi-subagents 等扩展注入）
// ⚠️ 字段来源有两种，渲染层必须同时兼容：
//   1. Pi SDK 内存消息（来自 sdkSession.messages）：role:"custom"，无顶层 type。
//      真实样本（pi-subagents 完成通知）：{role:"custom", customType:"subagent-notification", content:"<task-notification>...", display:true, ...}
//   2. 前端构造的占位消息（如 AgentSwitcher 的 agent_switch 分隔行）：顶层 type:"custom"，无 role。
//   3. session 文件 JSONL 持久化格式：顶层 type:"custom_message"（SDK 加载时自动转为 role:"custom" 内存消息）。
export interface CustomMessage {
	type?: "custom_message" | "custom"; // 前端构造时用；SDK 内存消息无此字段
	role?: "custom"; // SDK 内存消息用；前端构造时无此字段
	customType: string; // "subagent-notification" / "agent_switch" / "intercom_message" / ...
	display?: boolean;
	content?: string;
	details?: unknown;
	timestamp: number;
}

// 前三者用 role 字段区分；CustomMessage 没有 role，用顶层 type 区分
export type RoleMessage = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentMessage = RoleMessage | CustomMessage;

// 镜像 @earendil-works/pi-ai AssistantMessageEvent（流式增量事件）
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
			partial: AssistantMessage;
	  }
	| {
			type: "done";
			reason: "stop" | "length" | "toolUse";
			message: AssistantMessage;
	  }
	| { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

// WaPi 投影：一条 Pi 消息 + WaPi 元信息
export interface SessionMessage {
	message: AgentMessage; // Pi 原生消息，原样透传
	agentName?: AgentName; // 哪个 agent 发的（assistant/toolResult 才有意义）
	sessionId?: string; // 路由用，会话 ID
}

export interface AgentState {
	name: AgentName;
	status: AgentStatus;
	tokenCount?: number;
	model?: string;
}

// ===== WS 协议事件 =====

// 前端 → kernel
export interface PromptEvent {
	type: "agent:prompt";
	projectId: string;
	sessionId: string;
	agentName: AgentName;
	text: string;
	model?: string;
	thinking?: ThinkingLevel;
	attachments?: AttachmentRef[];
}

export type AttachmentRef =
	| { kind: "image"; name: string; path: string; size: number }
	| { kind: "file"; name: string; path: string; size: number }
	| {
			kind: "audio";
			name: string;
			path: string;
			size: number;
			durationMs?: number;
	  }
	| { kind: "folder"; name: string; path: string }
	| { kind: "snippet"; name: string; content: string };

// 附件草稿：composer 本地状态/IndexedDB 中使用的附件元数据，结构与 AttachmentRef 相同
export type AttachmentDraft =
	| { kind: "image"; name: string; path: string; size: number }
	| { kind: "file"; name: string; path: string; size: number }
	| {
			kind: "audio";
			name: string;
			path: string;
			size: number;
			durationMs?: number;
	  }
	| { kind: "folder"; name: string; path: string }
	| { kind: "snippet"; name: string; content: string };

export interface AbortEvent {
	type: "agent:abort";
	projectId: string;
	sessionId: string;
	agentName: AgentName;
}
// ask_user_question 应答（client → kernel），直达 AskRegistry，不经 steer/followUp 队列
export interface AskAnswerEvent {
	type: "agent:answer";
	sessionId: string;
	toolCallId: string;
	reply: AskReply;
}
export interface AskCancelAskEvent {
	type: "agent:cancel-ask";
	sessionId: string;
	toolCallId: string;
}
/** 简化版引导：前端乐观更新后直调 pi steer() */
export interface SteerMessageEvent {
	type: "steer:message";
	sessionId: string;
	text: string;
}
/** 简化版立即执行：abort + steer */
export interface SteerImmediateMessageEvent {
	type: "steer:immediate-message";
	sessionId: string;
	text: string;
}
/** 清空会话 followUp 排队列表（fire-and-forget） */
export interface ClearQueueEvent {
	type: "clear-queue";
	sessionId: string;
}

export interface ProjectCreateEvent {
	type: "project:create";
	name: string;
	cwd: string;
}
export interface ProjectUpdateEvent {
	type: "project:update";
	projectId: string;
	name?: string;
	cwd?: string;
}
export interface ProjectDeleteEvent {
	type: "project:delete";
	projectId: string;
}
export interface ProjectOpenDirEvent {
	type: "project:open-dir";
	projectId: string;
	sessionId?: string; // 默认工作区会话级目录打开
}
export interface SessionRenameEvent {
	type: "session:rename";
	sessionId: string;
	title: string;
}
export interface SessionDeleteEvent {
	type: "session:delete";
	sessionId: string;
}
export interface AgentConfigGetEvent {
	type: "agent:config:get";
	agentName: AgentName;
}
export interface AgentConfigSaveEvent {
	type: "agent:config:save";
	agentName: AgentName;
	config: AgentConfig;
}
export interface AgentListRequest {
	type: "agent:list";
}
export interface AgentCreateEvent {
	type: "agent:create";
	displayName: string;
}
export interface AgentDeleteEvent {
	type: "agent:delete";
	name: string;
}
export interface AgentToolsListRequest {
	type: "agent:tools:list";
}
export interface SessionSetAgentEvent {
	type: "session:set-agent";
	sessionId: string;
	agentName: AgentName;
}
export interface SessionReloadEvent {
	type: "session:reload";
	sessionId: string;
}
export interface ProjectsListRequest {
	type: "projects:list";
}
export interface SessionMessagesRequest {
	type: "session:messages";
	sessionId: string;
}
/** ask double check：查询该 session 当前真实 pending 的 ask toolCallId 列表 */
export interface SessionAsksRequest {
	type: "session:asks";
	sessionId: string;
}
/** 查询会话 token 统计（pi get_session_stats 官方口径，或本地 jsonl 降级）：
 *  全会话累计 tokens + 当前上下文窗口占用 contextUsage。 */
export interface SessionStatsRequest {
	type: "session:stats";
	sessionId: string;
}

// ===== 通用设置（系统设置 > 通用）=====
/** pi 自动重试配置（持久化在 settings.json.retry，pi settings-manager 直接消费） */
export interface RetrySettings {
	maxRetries: number; // 重试次数上限，0-10，默认 3
	baseDelayMs: number; // 指数退避基数（ms），默认 2000；实际延迟 = baseDelayMs × 2^(n-1)
}
/** 读取通用设置 */
export interface SettingsGetRequest {
	type: "settings:get";
}
/** 保存通用设置（retry 为完整对象，整体覆盖 settings.json.retry） */
export interface SettingsSaveEvent {
	type: "settings:save";
	retry: RetrySettings;
}
/** kernel → 前端：当前通用设置（settings:get 响应 / settings:save 成功后回显） */
export interface SettingsCurrentResult {
	type: "settings:current";
	retry: RetrySettings;
}

// client → kernel
/** 请求内置 subagent 列表（含 pi-subagents 真实 systemPrompt/builtinToolNames + 用户 override） */
export interface SubagentListRequest {
	type: "subagent:list";
}
/** 保存内置 subagent 的 model/thinking 覆盖 */
export interface SubagentSaveOverrideEvent {
	type: "subagent:save-override";
	override: SubagentOverride;
}

export type WSClientEvent =
	| PromptEvent
	| AbortEvent
	| AskAnswerEvent
	| AskCancelAskEvent
	| SteerMessageEvent
	| SteerImmediateMessageEvent
	| ClearQueueEvent
	| ProjectCreateEvent
	| ProjectUpdateEvent
	| ProjectDeleteEvent
	| ProjectOpenDirEvent
	| SessionRenameEvent
	| SessionDeleteEvent
	| AgentConfigGetEvent
	| AgentConfigSaveEvent
	| AgentListRequest
	| AgentCreateEvent
	| AgentDeleteEvent
	| AgentToolsListRequest
	| SessionSetAgentEvent
	| SessionReloadEvent
	| SessionCommandsRequest
	| ProjectsListRequest
	| SessionMessagesRequest
	| SessionAsksRequest
	| SessionStatsRequest
	| ProviderListEvent
	| ProviderSaveEvent
	| ProviderDeleteEvent
	| ProviderTestEvent
	| ModelPresetsRequest
	| SkillListEvent
	| SkillToggleEvent
	| SkillDirAddEvent
	| SkillDirRemoveEvent
	| ExtensionListEvent
	| ExtensionToggleEvent
	| ExtensionInstallEvent
	| ExtensionUninstallEvent
	| ExtensionUpgradeEvent
	| ExtensionCommandsListEvent
	| ExtensionCommandToggleEvent
	| MemoryListEvent
	| MemoryUpdateEvent
	| MemoryArchiveEvent
	| MemoryRestoreEvent
	| MemoryPurgeEvent
	| MemoryAddEvent
	| InstructionListEvent
	| MemoryConfigGetEvent
	| MemoryConfigSetEvent
	| McpListEvent
	| McpSaveEvent
	| McpDeleteEvent
	| McpTestEvent
	| McpListToolsEvent
	| McpClearAuthEvent
	| FSHomeRequest
	| FSRootsRequest
	| FSListDirRequest
	| FSReadFileRequest
	| FSUploadRequest
	| FSCopyRequest
	| FSSearchRequest
	| FSSearchCancelRequest
	| FSRecordingAppendRequest
	| FSRecordingFinalizeRequest
	| FSRecordingDiscardRequest
	| SubagentListRequest
	| SubagentSaveOverrideEvent
	| SettingsGetRequest
	| SettingsSaveEvent;

// kernel → 前端
/** 内置 subagent 列表结果（前端 AgentConfig 展示 + 收藏用） */
export interface SubagentListResult {
	type: "subagent:list";
	subagents: SubagentInfo[];
}

// =========================================================================
// 子代理进度（流式 bridge + 前端实时展示共用）
// =========================================================================

/** 子代理执行过程事件（由 subagent-runner 采集，经 onProgress 透传） */
export interface SubagentProgressEvent {
	agent: string;
	status: "running" | "done" | "error";
	output: string;
	tools: Array<{ id: string; name: string; status: string }>;
	elapsedMs: number;
}

/** bridge 流式协议帧（NDJSON，每帧一行） */
export type BridgeStreamFrame =
	| { type: "started"; protocol: 1; tool: string; toolCallId: string }
	| {
			type: "progress";
			tool: string;
			toolCallId: string;
			progress: SubagentProgressEvent;
	  }
	// 心跳帧：子代理长时间静默（长推理/慢首 token/单个长工具调用）时保活，
	// 消费方收到任意帧即刷新空闲超时；ping 不携带业务数据，消费方忽略即可
	| { type: "ping"; tool: string; toolCallId: string }
	| {
			type: "final";
			tool: string;
			toolCallId: string;
			ok: boolean;
			result?: {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
			error?: string;
	  };

/** SSE 事件：子代理进度（前端按 sessionId + toolCallId 路由到 DelegateCard/FleetCard） */
export interface SubagentProgressServerEvent {
	type: "subagent:progress";
	sessionId: string;
	toolCallId: string;
	progress: SubagentProgressEvent;
}

export interface ProjectsListEvent {
	type: "projects:list";
	projects: ProjectEntity[];
	sessions: SessionEntity[];
}
export interface ProjectCreatedEvent {
	type: "project:created";
	project: ProjectEntity;
}
export interface SessionCreatedEvent {
	type: "session:created";
	session: SessionEntity;
}
export interface SessionMessagesEvent {
	type: "session:messages";
	sessionId: string;
	messages: SessionMessage[];
	isActive: boolean;
	thinkingSince: number | null;
}
export interface SessionAsksEvent {
	type: "session:asks";
	sessionId: string;
	pending: string[];
}
export interface SessionStatsResult {
	type: "session:stats";
	sessionId: string;
	stats: {
		/** 平铺五字段 = 主代理 + 子代理合计；main/subagent 为拆分（旧 kernel 可能缺省） */
		tokens?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
			main?: TokenUsageSummary;
			subagent?: TokenUsageSummary;
		};
		contextUsage?: {
			used: number;
			total: number;
			ratio: number;
		} | null;
	} | null;
}
export interface SessionEchoUserEvent {
	type: "session:echo_user";
	sessionId: string;
	text: string;
	agentName: AgentName;
}
/** 会话 pi 进程预热完成（点开会话触发后台 ensureStarted）：
 *  官方 get_session_stats 自此可用，前端应收听后重拉 /stats 补齐 contextUsage。 */
export interface SessionActivatedEvent {
	type: "session:activated";
	sessionId: string;
}
export interface AgentConfigEvent {
	type: "agent:config";
	agentName: AgentName;
	config: AgentConfig;
}
export interface AgentListResult {
	type: "agent:list";
	agents: AgentConfig[];
}
export interface AgentCreatedEvent {
	type: "agent:created";
	agent: AgentConfig;
}
export interface AgentDeletedEvent {
	type: "agent:deleted";
	name: string;
}
export interface AgentToolItem {
	name: string;
	source: string;
} // source: "内置" | "MCP" | <插件包名>
export interface AgentToolsListResult {
	type: "agent:tools:list";
	tools: AgentToolItem[];
}
export interface SessionUpdatedEvent {
	type: "session:updated";
	sessionId: string;
	primaryAgent: AgentName;
}
export interface ErrorEvent {
	type: "error";
	message: string;
	agentName?: AgentName;
	sessionId?: string; // 真正出错的会话；前端据此精确路由，缺省回落 currentSessionId
}
// 模型 Provider 连接状态：网络类临时错误（Connection error / timeout 等）。
// 与 SSE 推送通道的 ConnectionState 区分——后者是 kernel→前端通道，这是 kernel→provider。
// 前端据此显示状态条而非红色会话消息。
export interface NetStatusEvent {
	type: "net:status";
	status: "degraded"; // 预留将来加 "recovered"
	message: string;
	agentName?: AgentName;
	sessionId?: string;
}

// fs 相关（kernel 读本地目录，供前端目录树选择器）
export interface FSHomeRequest {
	type: "fs:home";
}
export interface FSRootsRequest {
	type: "fs:roots";
}
export interface FSListDirRequest {
	type: "fs:listDir";
	path: string;
	showHidden?: boolean;
}
export interface FSHomeResult {
	type: "fs:home";
	home: string;
}
export interface FSRootsResult {
	type: "fs:roots";
	roots: string[];
}
export interface DirEntry {
	name: string;
	isDir: boolean;
	path?: string;
}
export interface FSListDirResult {
	type: "fs:listDir";
	path: string;
	entries: DirEntry[];
}
export interface FSReadFileRequest {
	type: "fs:readFile";
	path: string;
}
export interface FSReadFileResult {
	type: "fs:readFile";
	path: string;
	content: string;
	mimeType?: string;
	error?: string;
	/** ENOENT 回退搜索命中时的真实路径（前端展示「已定位到 ...」） */
	resolvedPath?: string;
}
export interface FSUploadRequest {
	type: "fs:upload";
	id: string;
	projectId: string;
	sessionId?: string;
	name: string;
	content: string;
}
export interface FSUploadResult {
	type: "fs:upload";
	id: string;
	path: string;
	error?: string;
}
export interface FSCopyRequest {
	type: "fs:copy";
	id: string;
	projectId: string;
	sessionId?: string;
	source: string;
}
export interface FSCopyResult {
	type: "fs:copy";
	id: string;
	path: string;
	error?: string;
}
export interface FSSearchRequest {
	type: "fs:search";
	query: string;
	root?: string;
	maxResults?: number;
	showHidden?: boolean;
	onlyDirs?: boolean;
	requestId?: string;
}
export interface FSSearchCancelRequest {
	type: "fs:search:cancel";
	requestId: string;
}
export interface FSSearchProgressEvent {
	type: "fs:search:progress";
	requestId: string;
	query: string;
	matches: DirEntry[];
	durationMs: number;
	truncated: boolean;
}
export interface FSSearchResult {
	type: "fs:search";
	requestId?: string;
	query: string;
	matches: DirEntry[];
	durationMs: number;
	truncated: boolean;
}
export interface FSErrorEvent {
	type: "fs:error";
	path: string;
	reason: string;
}
/** 文件不支持预览（非文本/超限等）：前端据此降级为下载/提示 */
export interface FSUnsupportedEvent {
	type: "fs:unsupported";
	path: string;
	reason: string;
}

// 录音：边录边落盘协议（与 fs:upload 同通道，id 关联请求-响应）
export interface FSRecordingAppendRequest {
	type: "fs:recording:append";
	id: string;
	projectId: string;
	sessionId?: string;
	recId: string;
	chunk: string;
}
export interface FSRecordingAppendResult {
	type: "fs:recording:append";
	id: string;
	error?: string;
}
export interface FSRecordingFinalizeRequest {
	type: "fs:recording:finalize";
	id: string;
	projectId: string;
	sessionId?: string;
	recId: string;
	finalName: string;
}
export interface FSRecordingFinalizeResult {
	type: "fs:recording:finalize";
	id: string;
	path: string;
	error?: string;
}
export interface FSRecordingDiscardRequest {
	type: "fs:recording:discard";
	id: string;
	projectId: string;
	sessionId?: string;
	recId: string;
}
export interface FSRecordingDiscardResult {
	type: "fs:recording:discard";
	id: string;
	error?: string;
}

// 镜像 SDK AgentSessionEvent 联合类型，作为 WS 透传事件
export type SDKEvent =
	| { type: "agent_start" }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
			elapsedMs?: number;
	  }
	| {
			// pi 自动重试开始（transient 错误后退避等待）：前置 agent_end 带 willRetry:true，
			// 重试期间本轮未终结，前端应保持 thinking。
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			// pi 自动重试终结：success=true 表示某次重试成功（本轮继续，终态仍由
			// agent_end 给出）；success=false 表示重试耗尽或退避期被 abort。
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| { type: "turn_start" }
	| {
			type: "turn_end";
			message: AgentMessage;
			toolResults: ToolResultMessage[];
	  }
	| { type: "message_start"; message: AgentMessage }
	| {
			type: "message_update";
			message: AgentMessage;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| { type: "message_end"; message: AgentMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: any;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: any;
			partialResult: any;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| {
			type: "compaction_start";
			reason: "manual" | "threshold" | "overflow";
	  }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: {
				summary: string;
				firstKeptEntryId: string;
				tokensBefore: number;
				estimatedTokensAfter: number;
				usage?: any;
				details?: any;
			} | null;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "extension_notify";
			message: string;
			notifyType?: string;
	  };

// WS 事件信封：包裹 sessionId 上下文，原始 SDK 事件原样透传
export interface SDKEventEnvelope {
	type: "sdk:event";
	projectId: string;
	sessionId: string;
	agentName: AgentName;
	event: SDKEvent;
}

export type WSServerEvent =
	| SDKEventEnvelope
	| ProjectsListEvent
	| ProjectCreatedEvent
	| SessionCreatedEvent
	| SessionMessagesEvent
	| SessionAsksEvent
	| SessionStatsResult
	| SessionActivatedEvent
	| SessionEchoUserEvent
	| AgentConfigEvent
	| ErrorEvent
	| NetStatusEvent
	| AgentListResult
	| AgentCreatedEvent
	| AgentDeletedEvent
	| AgentToolsListResult
	| SessionUpdatedEvent
	| ProviderListResult
	| ProviderTestResult
	| ProviderChangedEvent
	| ModelPresetsResult
	| SkillListResult
	| SkillChangedEvent
	| ExtensionListResult
	| ExtensionChangedEvent
	| ExtensionErrorEvent
	| ExtensionProgressEvent
	| ExtensionInstallDoneEvent
	| ExtensionNotifyEvent
	| ExtensionCommandsListResult
	| ExtensionCommandToggleResult
	| ExtensionCommandsChangedEvent
	| MemoryListResult
	| MemoryChangedEvent
	| McpListResult
	| McpChangedEvent
	| McpTestResult
	| McpToolsResult
	| InstructionListResult
	| MemoryConfigEvent
	| FSHomeResult
	| FSRootsResult
	| FSListDirResult
	| FSReadFileResult
	| FSUploadResult
	| FSCopyResult
	| FSSearchResult
	| FSSearchProgressEvent
	| FSErrorEvent
	| FSUnsupportedEvent
	| FSRecordingAppendResult
	| FSRecordingFinalizeResult
	| FSRecordingDiscardResult
	| SubagentListResult
	| SessionCommandsResult
	| SettingsCurrentResult
	| SubagentProgressServerEvent;

export type WSEvent = WSClientEvent | WSServerEvent;
