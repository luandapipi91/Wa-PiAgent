import type { AgentName } from "./types";

export const WS_PORT = 9776;
export const PREVIEW_PORT = 9777;

// 兼容浏览器（无 process 全局）与 Node/Bun（kernel sidecar）
const env = typeof process !== "undefined" ? process.env : {};
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
