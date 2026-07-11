// HiAgent 共享类型定义

import type {
  ProviderListEvent, ProviderSaveEvent, ProviderDeleteEvent, ProviderTestEvent,
  ProviderListResult, ProviderTestResult, ProviderChangedEvent,
} from "./providers";
import type {
  SkillListEvent, SkillToggleEvent, SkillDirAddEvent, SkillDirRemoveEvent,
  SkillListResult, SkillChangedEvent,
} from "./skills";
import type {
  ExtensionListEvent, ExtensionToggleEvent,
  ExtensionListResult, ExtensionChangedEvent,
} from "./extensions";
import type {
  MemoryListEvent, MemoryUpdateEvent, MemoryArchiveEvent, MemoryRestoreEvent,
  MemoryPurgeEvent, MemoryAddEvent, InstructionListEvent, MemoryConfigGetEvent, MemoryConfigSetEvent,
  MemoryListResult, MemoryChangedEvent, InstructionListResult, MemoryConfigEvent,
} from "./memory";

export type AgentName = "product" | "pm" | "dev" | "test";
export type AgentStateKey = `${string}:${AgentName}`;
export type AgentStatus = "idle" | "thinking" | "blocked";

// Composer / Prompt 的思考强度档位（UI 选择器）
export type ThinkingLevel = "disabled" | "medium" | "high" | "max";

export interface Partners {
  askTo: AgentName[];
  askFrom: AgentName[];
}

export interface AgentConfig {
  name: AgentName;
  displayName: string;
  avatar: string;
  avatarColor: string;        // "hex-hex" 渐变
  description: string;
  model: string;
  thinking: "low" | "medium" | "high";
  systemPromptMode: "replace" | "append";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  tools: string[];
  skills: string[];
  mcpServers: string[];
  partners: Partners;
  systemPromptBody?: string;  // frontmatter 后的正文
}

export interface ProjectEntity {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
}

export interface SessionEntity {
  id: string;
  projectId: string;
  primaryAgent: AgentName;
  title: string;
  createdAt: number;
  lastActivity: number;
  piSessionFile: string;  // SDK jsonl 文件路径 ~/.hiagent/sessions/<id>.jsonl
}

// ===== Pi 原生消息类型（镜像 @mariozechner/pi-ai，避免运行时依赖）=====
// 说明：Pi 原生类型还带 textSignature/thinkingSignature/redacted/thoughtSignature
// 等签名/脱敏字段，前端渲染用不到，这里按"最小可渲染集"省略。

export interface TextContent { type: "text"; text: string; }
export interface ThinkingContent { type: "thinking"; thinking: string; redacted?: boolean; }
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; }
export interface ImageContent { type: "image"; data: string; mimeType: string; }

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
  // 简化：忽略 usage/api/provider/responseModel/responseId（前端用不到）
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

// Pi custom 消息（intercom 等扩展注入）
// ⚠️ 关键：Pi 真实数据里这类消息的区分字段是顶层 type，不是 role
// （真实样本：{"type":"custom_message",...} / {"type":"custom",...}）
export interface CustomMessage {
  type: "custom_message" | "custom";   // ← Pi 顶层 type，不是 role
  customType: string;                   // "intercom_message" / "intercom_sent" / ...
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
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

// HiAgent 投影：一条 Pi 消息 + HiAgent 元信息
export interface SessionMessage {
  message: AgentMessage;     // Pi 原生消息，原样透传
  agentName?: AgentName;     // 哪个 agent 发的（assistant/toolResult 才有意义）
  sessionId?: string;        // 路由用，会话 ID
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
  | { kind: "folder"; name: string; path: string }
  | { kind: "snippet"; name: string; content: string };

// 附件草稿：composer 本地状态/IndexedDB 中使用的附件元数据，结构与 AttachmentRef 相同
export type AttachmentDraft =
  | { kind: "image"; name: string; path: string; size: number }
  | { kind: "file"; name: string; path: string; size: number }
  | { kind: "folder"; name: string; path: string }
  | { kind: "snippet"; name: string; content: string };

export interface AbortEvent {
  type: "agent:abort";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
}
export interface SteerPromoteEvent {
  type: "steer:promote";
  sessionId: string;
  text: string;
  remainingTexts: string[];
}
export interface SteerImmediateEvent {
  type: "steer:immediate";
  sessionId: string;
  text: string;
  remainingTexts: string[];
}
export interface SteerCancelEvent {
  type: "steer:cancel";
  sessionId: string;
}
export interface SteerClearQueueEvent {
  type: "steer:clear-queue";
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
export interface ProjectsListRequest { type: "projects:list"; }
export interface SessionMessagesRequest {
  type: "session:messages";
  sessionId: string;
}

export type WSClientEvent =
  | PromptEvent | AbortEvent
  | SteerPromoteEvent | SteerImmediateEvent | SteerCancelEvent | SteerClearQueueEvent
  | ProjectCreateEvent | ProjectUpdateEvent | ProjectDeleteEvent | ProjectOpenDirEvent
  | SessionRenameEvent | SessionDeleteEvent
  | AgentConfigGetEvent | AgentConfigSaveEvent
  | ProjectsListRequest | SessionMessagesRequest
  | ProviderListEvent | ProviderSaveEvent | ProviderDeleteEvent | ProviderTestEvent
  | SkillListEvent | SkillToggleEvent | SkillDirAddEvent | SkillDirRemoveEvent
  | ExtensionListEvent | ExtensionToggleEvent
  | MemoryListEvent | MemoryUpdateEvent | MemoryArchiveEvent | MemoryRestoreEvent | MemoryPurgeEvent | MemoryAddEvent
  | InstructionListEvent
  | MemoryConfigGetEvent | MemoryConfigSetEvent
  | FSHomeRequest | FSRootsRequest | FSListDirRequest | FSReadFileRequest | FSUploadRequest | FSCopyRequest | FSSearchRequest | FSSearchCancelRequest;

// kernel → 前端
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
  messages: SessionMessage[];   // ← 从 ChatMessage[] 改
}
export interface AgentConfigEvent {
  type: "agent:config";
  agentName: AgentName;
  config: AgentConfig;
}
export interface ErrorEvent {
  type: "error";
  message: string;
  agentName?: AgentName;
  sessionId?: string;  // 真正出错的会话；前端据此精确路由，缺省回落 currentSessionId
}

// fs 相关（kernel 读本地目录，供前端目录树选择器）
export interface FSHomeRequest { type: "fs:home"; }
export interface FSRootsRequest { type: "fs:roots"; }
export interface FSListDirRequest { type: "fs:listDir"; path: string; showHidden?: boolean; }
export interface FSHomeResult { type: "fs:home"; home: string; }
export interface FSRootsResult { type: "fs:roots"; roots: string[]; }
export interface DirEntry { name: string; isDir: boolean; path?: string; }
export interface FSListDirResult { type: "fs:listDir"; path: string; entries: DirEntry[]; }
export interface FSReadFileRequest { type: "fs:readFile"; path: string; }
export interface FSReadFileResult { type: "fs:readFile"; path: string; content: string; mimeType?: string; error?: string; }
export interface FSUploadRequest { type: "fs:upload"; id: string; projectId: string; name: string; content: string; }
export interface FSUploadResult { type: "fs:upload"; id: string; path: string; error?: string; }
export interface FSCopyRequest { type: "fs:copy"; id: string; projectId: string; source: string; }
export interface FSCopyResult { type: "fs:copy"; id: string; path: string; error?: string; }
export interface FSSearchRequest { type: "fs:search"; query: string; root?: string; maxResults?: number; showHidden?: boolean; onlyDirs?: boolean; requestId?: string; }
export interface FSSearchCancelRequest { type: "fs:search:cancel"; requestId: string; }
export interface FSSearchProgressEvent { type: "fs:search:progress"; requestId: string; query: string; matches: DirEntry[]; durationMs: number; truncated: boolean; }
export interface FSSearchResult { type: "fs:search"; requestId?: string; query: string; matches: DirEntry[]; durationMs: number; truncated: boolean; }
export interface FSErrorEvent { type: "fs:error"; path: string; reason: string; }

// 镜像 SDK AgentSessionEvent 联合类型，作为 WS 透传事件
export type SDKEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] };

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
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | SessionMessagesEvent
  | AgentConfigEvent | ErrorEvent
  | ProviderListResult | ProviderTestResult | ProviderChangedEvent
  | SkillListResult | SkillChangedEvent
  | ExtensionListResult | ExtensionChangedEvent
  | MemoryListResult | MemoryChangedEvent
  | InstructionListResult | MemoryConfigEvent
  | FSHomeResult | FSRootsResult | FSListDirResult | FSReadFileResult | FSUploadResult | FSCopyResult | FSSearchResult | FSSearchProgressEvent | FSErrorEvent;

export type WSEvent = WSClientEvent | WSServerEvent;
