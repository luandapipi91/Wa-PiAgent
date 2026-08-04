// ===== slash 命令类型定义 =====

/**
 * 命令来源（对齐 pi get_commands RPC 返回的 source 字段）。
 * - extension：插件通过 registerCommand 注册（如 /goal）
 * - prompt：用户自定义 prompt template
 * - skill：技能（pi 返回但前端过滤掉，技能走 $ 菜单）
 * - builtin：pi 内置框架命令（前端静态表维护）
 */
export type CommandSource = "extension" | "prompt" | "skill" | "builtin";

/** 单条命令信息 */
export interface CommandInfo {
  name: string;            // 命令名（不含 / 前缀）
  description?: string;
  source: CommandSource;
  // 新增（仅 extension 来源填充）：
  packageName?: string;    // 插件包名（裸包名，如 @narumitw/pi-goal，对应 waPiCommandToggles key）
  enabled?: boolean;       // 命令开关状态（缺省 false）
  tuiOnly?: boolean;       // TUI-only 检测标记
}

// ===== WS 协议事件（命令查询）=====

// 前端 → kernel
export interface SessionCommandsRequest {
  type: "session:commands";
  sessionId: string;
  /** 新会话页面：session 尚未在后端创建时，传入 projectId + agentName 让后端自动创建 */
  projectId?: string;
  agentName?: string;
}

// kernel → 前端
export interface SessionCommandsResult {
  type: "session:commands";
  sessionId: string;
  commands: CommandInfo[];
}

// ===== kernel 拦截的 pi 内置命令 =====

/**
 * kernel 拦截处理的 pi 内置命令清单（拦截语义的唯一权威来源）。
 * pi RPC 模式不解析内置斜杠命令（仅交互模式解析），文本若按普通 prompt 发出
 * 会被当作 user 消息发给 LLM，命令从不执行。这些命令由 kernel 显式转对应
 * RPC 调用执行，不产生 user 回声——前端据此不把命令文本显示为用户聊天消息。
 */
export const KERNEL_INTERCEPTED_COMMANDS = ["compact"] as const;

export type KernelInterceptedCommand =
  (typeof KERNEL_INTERCEPTED_COMMANDS)[number];

/**
 * 匹配 kernel 拦截的内置命令：命中返回命令名，否则 null。
 * 命令名后必须跟空白或结束（避免误伤 /compactify 这类同前缀词）。
 */
export function matchKernelCommand(
  text: string,
): KernelInterceptedCommand | null {
  const m = /^\/(\w+)(?:\s|$)/.exec(text.trim());
  if (!m) return null;
  return (KERNEL_INTERCEPTED_COMMANDS as readonly string[]).includes(m[1])
    ? (m[1] as KernelInterceptedCommand)
    : null;
}
