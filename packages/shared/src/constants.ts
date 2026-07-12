import type { AgentName } from "./types";

/** 端口解析：合法正整数用之，否则用默认。 */
export function resolvePort(envVal: string | undefined, def: number): number {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// 兼容浏览器（vite import.meta.env / 无 process 全局）与 Node/Bun（process.env）
// 浏览器 bundle 里 process 是 undefined；vite 通过 vite.config.ts 的 define 把
// process.env.HIAGENT_DIR 等静态替换为构建时值（E2E 隔离目录用）。
// 但 typeof process 判断在替换前已求值为 "undefined"，所以这里双源读取兜底。
const nodeEnv = typeof process !== "undefined" ? process.env : {};
// import.meta.env 浏览器（vite）才有；Node/Bun 下 import.meta.env 为 undefined，由 && 兜底
const browserEnv = (typeof import.meta !== "undefined" && (import.meta as any).env) ? (import.meta as any).env : {};
const env = { ...nodeEnv, ...browserEnv };
const HOME = env.HOME || env.USERPROFILE || ".";
export const WS_PORT = resolvePort(env.HIAGENT_WS_PORT, 9776);
export const PREVIEW_PORT = resolvePort(env.HIAGENT_PREVIEW_PORT, 9777);
/** 前端 dev 端口（Vite）；desktop 不用（走同源 9776）。 */
export const FRONTEND_PORT = resolvePort(env.HIAGENT_WEB_PORT, 5180);
// 支持 env 覆盖（E2E 测试用独立目录隔离，生产部署也可自定义数据目录）
export const HIAGENT_DIR = env.HIAGENT_DIR || `${HOME}/.hiagent`;
export const PROJECTS_FILE = `${HIAGENT_DIR}/projects.json`;
export const PI_AGENTS_DIR = `${HIAGENT_DIR}/agents`;   // ← 改：从 ~/.pi/agent/agents 改为 .hiagent/agents
export const PROVIDERS_FILE = `${HIAGENT_DIR}/providers.json`;
export const GENERATED_DIR = `${HIAGENT_DIR}/.generated`;   // 自动生成的 Pi extension 文件目录
export const BUILTIN_SKILLS_DIR = `${HIAGENT_DIR}/skills`;   // 内置技能目录，kernel 启动时创建，不可删

export interface AgentDef {
  emoji: string;
  gradient: [string, string];
  label: string;
}

export const AGENT_DEFS: Record<AgentName, AgentDef> = {
  product: { emoji: "📋", gradient: ["#5B5BD6", "#8B8BFF"], label: "需求设计" },
  pm:      { emoji: "📅", gradient: ["#B45309", "#D97706"], label: "项目管理" },
  dev:     { emoji: "⚙️", gradient: ["#1D1D1F", "#2C2C2E"], label: "技术实现" },
  test:    { emoji: "🧪", gradient: ["#34A853", "#4BA26F"], label: "质量验收" },
};

/** 所有 Agent 名称列表，用于批量操作（如预启动所有 agent 进程） */
export const ALL_AGENT_NAMES: AgentName[] = ["product", "pm", "dev", "test"];

/** Agent 未显式配置 tools 时的默认工具集。
 *  含 Pi 内置工具、pi-web-access 网络工具、amaster memory 记忆工具，
 *  以及 pi-lens（LSP 诊断插件）注册的代码智能工具。
 *  注意：createAgentSession 的 tools 参数会被 SDK 当作 allowlist 使用，
 *  customTools（memory_add/replace/remove/read）和扩展注册的工具
 *  （lsp_navigation 等）同样要过这道 allowlist，未列出的工具会被过滤掉，
 *  因此必须在这里显式放行。 */
export const DEFAULT_AGENT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
  // amaster memory 记忆工具（host-controlled，经 customTools 注入，须显式放行）
  "memory_add",
  "memory_replace",
  "memory_remove",
  "memory_read",
  "session_search",
  // pi-lens（LSP 诊断插件）注册的代码智能工具
  "lsp_navigation",      // LSP 代码导航：定义/引用/类型/hover 等
  "lsp_diagnostics",     // LSP 诊断：类型错误/告警（构建/测试前用）
  "lens_diagnostics",    // lens 综合诊断
  "ast_grep_search",     // ast-grep 结构化代码搜索
  "ast_grep_replace",    // ast-grep 结构化代码替换
  "ast_grep_outline",    // ast-grep 代码大纲
  "module_report",       // 模块依赖报告
  "read_symbol",         // 按符号读取代码
  "read_enclosing",      // 读取符号的封闭作用域
  "ask_user_question",
];

/** 各可选插件注册的工具名（插件禁用时从 allowlist 过滤掉）。
 *  键 = OPTIONAL_EXTENSIONS 里的插件 id（见 kernel/extensions.ts）。 */
export const EXTENSION_TOOL_MAP: Record<string, string[]> = {
  "pi-lens": [
    "lsp_navigation",
    "lsp_diagnostics",
    "lens_diagnostics",
    "ast_grep_search",
    "ast_grep_replace",
    "ast_grep_outline",
    "module_report",
    "read_symbol",
    "read_enclosing",
  ],
};

/**
 * 按「可选插件启用态」过滤工具 allowlist 的纯函数。
 * - baseTools：agent 配置的 tools 或 DEFAULT_AGENT_TOOLS
 * - enabledExtensionIds：当前启用的插件 id 集合（由 ExtensionManager.list() 提供）
 * - agentName：预留参数，后期按角色（product/pm/test 不需要代码工具）做进一步过滤
 */
export function resolveAgentTools(
  baseTools: string[],
  enabledExtensionIds: Set<string>,
  _agentName?: string,
): string[] {
  let tools = baseTools;
  for (const [extId, extTools] of Object.entries(EXTENSION_TOOL_MAP)) {
    if (!enabledExtensionIds.has(extId)) {
      const remove = new Set(extTools);
      tools = tools.filter((t) => !remove.has(t));
    }
  }
  return tools;
}
