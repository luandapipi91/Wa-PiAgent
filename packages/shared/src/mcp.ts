// ===== MCP 服务器配置管理类型定义 =====

/** MCP OAuth 配置（兼容 pi-mcp-adapter） */
export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/** MCP 服务器配置（兼容 .mcp.json 格式） */
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "bearer" | "oauth";
  bearerToken?: string;
  oauth?: McpOAuthConfig;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean | string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  debug?: boolean;
}

/** 工具参数摘要 */
export interface McpToolParam {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
}

/** MCP 工具摘要（来自 mcp-cache.json） */
export interface McpToolSummary {
  name: string;
  description?: string;
  parameters?: McpToolParam[];
}

/** 服务器运行时状态 */
export type McpServerStatus = "disconnected" | "connected" | "needs_auth" | "error";

// ===== WS 协议事件 =====

// 前端 → 内核
export interface McpListEvent      { type: "mcp:list";      projectId?: string; }
export interface McpSaveEvent      { type: "mcp:save";      projectId?: string; config: McpServerConfig; originalName?: string; }
export interface McpDeleteEvent    { type: "mcp:delete";    projectId?: string; serverName: string; }
export interface McpTestEvent      { type: "mcp:test";      projectId?: string; serverName: string; }
export interface McpListToolsEvent { type: "mcp:listTools"; projectId?: string; serverName: string; }
export interface McpClearAuthEvent { type: "mcp:clearAuth"; projectId?: string; serverName: string; }

// 内核 → 前端
export interface McpListResult   { type: "mcp:list";    projectId?: string; servers: McpServerConfig[]; }
export interface McpChangedEvent { type: "mcp:changed"; projectId?: string; servers: McpServerConfig[]; }
export interface McpTestResult   {
  type: "mcp:testResult";
  serverName: string;
  /** true 仅表示「已连上」；needs_auth 不算 success */
  success: boolean;
  /** 运行时状态（前端据此切换卡片徽标 / 授权按钮） */
  status?: McpServerStatus;
  /** 连上时的工具数，供卡片展示 */
  toolCount?: number;
  error?: string;
}
export interface McpToolsResult  { type: "mcp:tools";      serverName: string; tools: McpToolSummary[]; }
