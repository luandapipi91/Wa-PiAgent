import type { AgentName } from "./types";

export const WS_PORT = 9776;
export const PREVIEW_PORT = 9777;

const HOME = process.env.HOME || process.env.USERPROFILE || ".";
export const HIAGENT_DIR = `${HOME}/.hiagent`;
export const PROJECTS_FILE = `${HIAGENT_DIR}/projects.json`;
export const SESSIONS_DIR = `${HIAGENT_DIR}/sessions`;
export const PI_AGENTS_DIR = `${HOME}/.pi/agent/agents`;

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
