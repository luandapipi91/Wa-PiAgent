import type { AgentName } from "./types";

export const WS_PORT = 9776;
export const PREVIEW_PORT = 9777;

// 兼容浏览器（vite import.meta.env / 无 process 全局）与 Node/Bun（process.env）
// 浏览器 bundle 里 process 是 undefined；vite 通过 vite.config.ts 的 define 把
// process.env.HIAGENT_DIR 等静态替换为构建时值（E2E 隔离目录用）。
// 但 typeof process 判断在替换前已求值为 "undefined"，所以这里双源读取兜底。
const nodeEnv = typeof process !== "undefined" ? process.env : {};
// import.meta.env 浏览器（vite）才有；Node/Bun 下 import.meta.env 为 undefined，由 && 兜底
const browserEnv = (typeof import.meta !== "undefined" && (import.meta as any).env) ? (import.meta as any).env : {};
const env = { ...nodeEnv, ...browserEnv };
const HOME = env.HOME || env.USERPROFILE || ".";
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
 *  含 Pi 内置工具、pi-web-access 网络工具，以及 amaster memory 记忆工具。
 *  注意：createAgentSession 的 tools 参数会被 SDK 当作 allowlist 使用，
 *  customTools（memory_add/replace/remove/read）同样要过这道 allowlist，
 *  未列出的工具会被过滤掉，因此必须在这里显式放行。 */
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
];
