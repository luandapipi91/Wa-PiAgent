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

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface AskItem {
  messageId: string;
  sessionId: string;
  from: AgentName;
  to: AgentName;
  text: string;
  startedAt: number;
  resolvedAt?: number;
  resolved?: boolean;
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
export interface InjectReplyEvent {
  type: "intercom:inject-reply";
  sessionId: string;
  askMessageId: string;
  text: string;
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
  | PromptEvent | AbortEvent | InjectReplyEvent
  | ProjectCreateEvent | ProjectUpdateEvent | ProjectDeleteEvent
  | SessionRenameEvent | SessionDeleteEvent
  | AgentConfigGetEvent | AgentConfigSaveEvent
  | ProjectsListRequest | SessionMessagesRequest;

// kernel → 前端
export interface MessageUpdateEvent {
  type: "agent:message";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  message: ChatMessage;
}
export interface StateChangeEvent {
  type: "agent:state";
  projectId: string;
  agentName: AgentName;
  state: AgentState;
}
export interface IntercomAskEvent {
  type: "intercom:ask";
  sessionId: string;
  ask: AskItem;
}
export interface IntercomReplyEvent {
  type: "intercom:reply";
  sessionId: string;
  askMessageId: string;
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
  messages: ChatMessage[];
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

export type WSServerEvent =
  | MessageUpdateEvent | StateChangeEvent
  | IntercomAskEvent | IntercomReplyEvent
  | ProjectsListEvent | ProjectCreatedEvent | SessionCreatedEvent
  | SessionMessagesEvent
  | AgentConfigEvent | ErrorEvent;

export type WSEvent = WSClientEvent | WSServerEvent;
