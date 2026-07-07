import type { AgentName } from "./types";

export const WS_PORT = 9776;
export const PREVIEW_PORT = 9777;

// 兼容浏览器（vite import.meta.env / 无 process 全局）与 Node/Bun（process.env）
// 浏览器 bundle 里 process 是 undefined；vite 通过 vite.config.ts 的 define 把
// process.env.HIAGENT_DIR 等静态替换为构建时值（E2E 隔离目录用）。
// 但 typeof process 判断在替换前已求值为 "undefined"，所以这里双源读取兜底。
const nodeEnv = typeof process !== "undefined" ? process.env : {};
// @ts-expect-error import.meta.env 浏览器才有，Node/Bun 下无此属性
const browserEnv = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};
const env = { ...nodeEnv, ...browserEnv };
const HOME = env.HOME || env.USERPROFILE || ".";
// 支持 env 覆盖（E2E 测试用独立目录隔离，生产部署也可自定义数据目录）
export const HIAGENT_DIR = env.HIAGENT_DIR || `${HOME}/.hiagent`;
export const HIAGENT_PI_AGENT_DIR = `${HIAGENT_DIR}/pi-agent`;  // ← 新增：Pi 数据目录（sessions/agents/auth/intercom）
export const PROJECTS_FILE = `${HIAGENT_DIR}/projects.json`;
export const SESSIONS_DIR = `${HIAGENT_DIR}/sessions`;  // HiAgent 自管元数据（不含 messages）
export const PI_AGENTS_DIR = `${HIAGENT_DIR}/agents`;   // ← 改：从 ~/.pi/agent/agents 改为 .hiagent/agents

export interface AgentDef {
  emoji: string;
  gradient: [string, string];
  label: string;
}

export const AGENT_DEFS: Record<AgentName, AgentDef> = {
  product: { emoji: "📋", gradient: ["#89b4fa", "#b4befe"], label: "需求设计" },
  pm:      { emoji: "📅", gradient: ["#f9e2af", "#ebbc9e"], label: "项目管理" },
  dev:     { emoji: "⚙️", gradient: ["#fab387", "#f38ba8"], label: "技术实现" },
  test:    { emoji: "🧪", gradient: ["#a6e3a1", "#94e2d5"], label: "质量验收" },
};

/** 所有 Agent 名称列表，用于批量操作（如预启动所有 agent 进程） */
export const ALL_AGENT_NAMES: AgentName[] = ["product", "pm", "dev", "test"];
