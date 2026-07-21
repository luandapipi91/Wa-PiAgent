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
export const PROMPTS_FILE = `${HIAGENT_DIR}/prompts.json`;   // 系统提示词段落配置（顺序+内容），启动时若无则初始化默认值
export const GENERATED_DIR = `${HIAGENT_DIR}/.generated`;   // 自动生成的 Pi extension 文件目录
export const BUILTIN_SKILLS_DIR = `${HIAGENT_DIR}/skills`;   // 内置技能目录，kernel 启动时创建，不可删

// ===== 默认工作区（虚拟系统项目）=====
// 一个常驻、不可删除/改名的虚拟项目，作为"没有具体工程目录时的默认聊天空间"。
// 该项目下的每个会话有独立 cwd（~/.hiagent/workdir/<session.createdAt>/），
// 详见 resolveSessionCwd 纯函数（pure.ts）。
export const SYSTEM_PROJECT_ID = "__system__";
export const SYSTEM_PROJECT_NAME = "默认工作区";
export const SYSTEM_PROJECT_CWD = `${HIAGENT_DIR}/workdir`;
// 默认工作区会话被删除后，对应的 <createdAt>/ 子目录保留天数；超时后由 workdir-cleaner 清理
export const WORKDIR_TTL_DAYS = 7;

export interface AgentDef {
  emoji: string;
  gradient: [string, string];
}

// 按 displayName 索引（displayName 既是展示名也是唯一标识符）
export const AGENT_DEFS: Record<string, AgentDef> = {
  "需求设计": { emoji: "📋", gradient: ["#5B5BD6", "#8B8BFF"] },
  "项目管理": { emoji: "📅", gradient: ["#B45309", "#D97706"] },
  "技术实现": { emoji: "⚙️", gradient: ["#1D1D1F", "#2C2C2E"] },
  "质量验收": { emoji: "🧪", gradient: ["#34A853", "#4BA26F"] },
};

/** 所有内置智能体的 displayName 列表，用于 seedDefaults 批量生成 */
export const ALL_AGENT_NAMES: string[] = ["需求设计", "项目管理", "技术实现", "质量验收"];

/** Agent 未显式配置 tools 时的默认工具集。
 *  含 Pi 内置工具、pi-web-access 网络工具、amaster memory 记忆工具。
 *  注意：createAgentSession 的 tools 参数会被 SDK 当作 allowlist 使用，
 *  customTools（memory_add/replace/remove/read）同样要过这道 allowlist，
 *  未列出的工具会被过滤掉，因此必须在这里显式放行。
 *  动态插件注册的工具不再写死在此处，改由 resolveAgentTools 在运行时按
 *  插件启用态从 EXTENSION_TOOL_MAP 注入。 */
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
  "ask_user_question",
  // delegate：宿主关系网调起工具（customTools 注入）
  "delegate",
];

/** 动态插件注册的工具登记表（运行时按插件启用态注入 agent allowlist）。
 *  键 = 扩展包名，与 settings.json.packages 的 npm:<name>@<version> 中 <name> 一致
 *  （即 ExtensionManager.list() 返回的 PackageInfo.name）。
 *  默认为空：内置工具已在 DEFAULT_AGENT_TOOLS 放行，第三方插件若注册工具，
 *  安装时在此登记即可被注入到启用它的 agent 的 allowlist。 */
export const EXTENSION_TOOL_MAP: Record<string, string[]> = {};

/**
 * 按「已启用动态插件」向工具 allowlist 注入插件工具的纯函数。
 * - baseTools：agent 配置的 tools 或 DEFAULT_AGENT_TOOLS
 * - enabledExtensionIds：当前启用的插件 id 集合（由 ExtensionManager.list() 提供）
 * - _agentName：预留参数，后期按角色（product/pm/test 不需要代码工具）做进一步过滤
 * - toolMap：工具登记表，默认用 EXTENSION_TOOL_MAP；测试可注入伪注册表
 * - harvestedTools：loader.reload() 后从 runtime.tools 枚举出的「动态发现」工具名
 *   （option B：取代手动维护 EXTENSION_TOOL_MAP 的静态登记）
 * 行为：保留 base 顺序，依次并入 toolMap（按启用态）与 harvestedTools，重复项去重；不修改入参。
 */
export function resolveAgentTools(
  baseTools: string[],
  enabledExtensionIds: Set<string>,
  _agentName?: string,
  toolMap: Record<string, string[]> = EXTENSION_TOOL_MAP,
  harvestedTools: Iterable<string> = [],
): string[] {
  // 扩展原生 subagent 工具永不放行：LLM 只能走宿主 delegate 工具（allowlist 强制）
  const BLOCKED = new Set(["subagent"]);
  const seen = new Set(baseTools);
  const result = [...baseTools];
  for (const [extId, extTools] of Object.entries(toolMap)) {
    if (enabledExtensionIds.has(extId)) {
      for (const t of extTools) {
        if (!seen.has(t)) {
          seen.add(t);
          result.push(t);
        }
      }
    }
  }
  // 动态发现：已加载扩展（builtin + 已启用第三方）注册的工具名，并入 allowlist 末尾
  for (const t of harvestedTools) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result.filter(t => !BLOCKED.has(t));
}

/** 按 displayName 取 AgentDef（emoji/gradient 视觉样式），未知 displayName 回退默认灰色 🤖 */
export function agentDefOf(displayName: string): AgentDef {
  return AGENT_DEFS[displayName] ?? { emoji: "🤖", gradient: ["#4b5563", "#6b7280"] };
}
