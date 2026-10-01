// ===== MCP 服务器配置管理类型定义 =====
//
// pi-mcp-adapter 时代字段（lifecycle / idleTimeout / requestTimeoutMs / directTools /
// excludeTools / exposeResources / debug）随 adapter 移除（任务 8 移除最后一个消费者）：
// 迁移读取它们走 `mcp-migrate.ts` 的原始对象（`Record<string, unknown>`），不再需要类型声明。

/** 工具暴露方式（规格 §8） */
export type McpExposure =
  | "codemode"
  | "codemode-deferred"
  | "deferred"
  | "direct"
  | "hidden";

/** MCP 服务器配置（兼容 .mcp.json 格式） */
export interface McpServerConfig {
  name: string;
  /** 传输类型；缺省时按 command / url 推断 */
  type?: "stdio" | "http" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 超时（秒），必须是正数 */
  timeout?: number;
  /** 是否启用；缺省为启用 */
  enabled?: boolean;
  /** 该服务器所有工具的默认暴露方式 */
  exposure?: McpExposure;
  /** 按工具名覆盖暴露方式 */
  toolExposure?: Record<string, McpExposure>;
}

/** 配置作用域 */
export interface McpScope {
  /** 缺省为全局 */
  projectId?: string;
}

/** 字段级校验错误（field 供表单定位，message 供展示） */
export interface McpFieldError {
  field: string;
  message: string;
}

/** 服务器名允许的字符集 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** 校验单个服务器配置；返回字段级错误（空数组表示合法）。规格 §8 */
export function validateMcpServer(input: McpServerConfig): McpFieldError[] {
  const errors: McpFieldError[] = [];
  if (!SERVER_NAME_RE.test(input.name ?? "")) {
    errors.push({ field: "name", message: "只允许字母、数字、下划线与连字符" });
  }
  const hasCommand = typeof input.command === "string" && input.command.length > 0;
  const hasUrl = typeof input.url === "string" && input.url.length > 0;
  if (hasCommand === hasUrl) {
    errors.push({
      field: hasCommand ? "url" : "command",
      message: "必须且只能提供 command 或 url 之一",
    });
  }
  if (input.type && input.type !== "stdio" && !hasUrl) {
    errors.push({ field: "type", message: `${input.type} 需要 url` });
  }
  if (input.type === "stdio" && !hasCommand) {
    errors.push({ field: "command", message: "stdio 需要 command" });
  }
  if (
    input.timeout !== undefined &&
    (!Number.isFinite(input.timeout) || input.timeout <= 0)
  ) {
    errors.push({ field: "timeout", message: "必须是正数（秒）" });
  }
  return errors;
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
export type McpServerStatus = "disconnected" | "connected" | "error";

// ===== WS 协议事件 =====

// 前端 → 内核
export interface McpListEvent {
  type: "mcp:list";
  projectId?: string;
}
export interface McpSaveEvent {
  type: "mcp:save";
  projectId?: string;
  config: McpServerConfig;
  originalName?: string;
}
export interface McpDeleteEvent {
  type: "mcp:delete";
  projectId?: string;
  serverName: string;
}
export interface McpTestEvent {
  type: "mcp:test";
  projectId?: string;
  serverName: string;
}
export interface McpListToolsEvent {
  type: "mcp:listTools";
  projectId?: string;
  serverName: string;
}

// 内核 → 前端
export interface McpListResult {
  type: "mcp:list";
  projectId?: string;
  servers: McpServerConfig[];
}
export interface McpChangedEvent {
  type: "mcp:changed";
  projectId?: string;
  servers: McpServerConfig[];
  // 与 `GET /api/mcp` 的清单元信息同形（kernel 的 broadcastChanged 逐字段拷贝）：
  // 前端据此显示「状态未知」（stale）与「项目未受信、配置被忽略」（note），
  // 去掉它们会让一次保存的广播抹掉这两处说明。可缺省是为了兼容不带元信息的生产者。
  /** pi / 写入层的错误列表 */
  errors?: string[];
  /** 命令本身没跑起来 / 输出不可解析 */
  commandFailed?: boolean;
  /** 有启用中的 server 处于异常态 */
  hasProblems?: boolean;
  /** 状态读取层无法刷新、用的是上一条缓存 → UI 必须显示「状态未知」 */
  stale?: boolean;
  /** pi 的顶层提示（项目未受信任时配置被忽略的唯一信号） */
  note?: string;
}
export interface McpTestResult {
  type: "mcp:testResult";
  serverName: string;
  /** true 仅表示「已连上」 */
  success: boolean;
  /** 运行时状态 */
  status?: McpServerStatus;
  /** 连上时的工具数，供卡片展示 */
  toolCount?: number;
  /** 错误信息（KernelError 时为 code，老渲染兜底用） */
  error?: string;
  /** 结构化错误：code 由前端字典渲染；detail 为技术细节 */
  code?: string;
  params?: Record<string, string | number>;
  detail?: string;
}
export interface McpToolsResult {
  type: "mcp:tools";
  serverName: string;
  /** 成功时的工具列表（与 error 互斥） */
  tools?: McpToolSummary[];
  /** listTools 失败时填充（与 tools 互斥） */
  error?: string;
}
