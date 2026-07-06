import type { AgentState, AgentStateKey, AgentName, AgentStatus } from "./types";

// 相对时间格式化：刚刚 / 2m / 1h / 昨天 / Nd / M/D
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day}d`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 全局聚合 agent 状态：blocked > thinking > idle
export function aggregateAgentState(states: AgentState[]): AgentStatus {
  if (states.some(s => s.status === "blocked")) return "blocked";
  if (states.some(s => s.status === "thinking")) return "thinking";
  return "idle";
}

export function makeAgentStateKey(projectId: string, agentName: AgentName): AgentStateKey {
  return `${projectId}:${agentName}`;
}

export function parseAgentStateKey(key: AgentStateKey): { projectId: string; agentName: AgentName } {
  const idx = key.indexOf(":");
  const projectId = key.slice(0, idx);
  const agentName = key.slice(idx + 1) as AgentName;
  return { projectId, agentName };
}

// 生成会话 id（前端 NewSessionPane 发 agent:prompt 时用作请求追踪 id）
import { randomUUID } from "node:crypto";
export function randomSessionId(): string {
  return `s-${randomUUID()}`;
}
