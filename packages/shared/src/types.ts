// HiAgent 共享类型定义

export type AgentName = "product" | "pm" | "dev" | "test";
export type AgentStateKey = `${string}:${AgentName}`;
export type AgentStatus = "idle" | "thinking" | "blocked";

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
}

/** @deprecated 富消息模型上线后，新消息走 SessionMessage。仅 agent:prompt 的用户输入包装还在用，Task 4 会清理。 */
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
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
  // 简化：忽略 usage/api/provider/responseModel/responseId/errorMessage（前端用不到）
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

// HiAgent 投影：一条 Pi 消息 + HiAgent 元信息
export interface SessionMessage {
  message: AgentMessage;     // Pi 原生消息，原样透传
  agentName?: AgentName;     // 哪个 agent 发的（assistant/toolResult 才有意义）
  sessionId?: string;        // 路由用，PiRpcClient 填 currentSessionId
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
}
export interface AbortEvent {
  type: "agent:abort";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
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
  | ProjectCreateEvent | ProjectUpdateEvent | ProjectDeleteEvent
  | SessionRenameEvent | SessionDeleteEvent
  | AgentConfigGetEvent | AgentConfigSaveEvent
  | ProjectsListRequest | SessionMessagesRequest
  | FSHomeRequest | FSRootsRequest | FSListDirRequest;

// kernel → 前端
export interface MessageUpdateEvent {
  type: "agent:message";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  message: SessionMessage;   // ← 从 ChatMessage 改
}
export interface StateChangeEvent {
  type: "agent:state";
  projectId: string;
  agentName: AgentName;
  state: AgentState;
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
}

// fs 相关（kernel 读本地目录，供前端目录树选择器）
export interface FSHomeRequest { type: "fs:home"; }
export interface FSRootsRequest { type: "fs:roots"; }
export interface FSListDirRequest { type: "fs:listDir"; path: string; }
export interface FSHomeResult { type: "fs:home"; home: string; }
export interface FSRootsResult { type: "fs:roots"; roots: string[]; }
export interface DirEntry { name: string; isDir: boolean; }
export interface FSListDirResult { type: "fs:listDir"; path: string; entries: DirEntry[]; }
export interface FSErrorEvent { type: "fs:error"; reason: string; }

export type WSServerEvent =
  | MessageUpdateEvent | StateChangeEvent
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | SessionMessagesEvent
  | AgentConfigEvent | ErrorEvent
  | FSHomeResult | FSRootsResult | FSListDirResult | FSErrorEvent;

export type WSEvent = WSClientEvent | WSServerEvent;
