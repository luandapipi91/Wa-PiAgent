import type { AgentState, AgentStateKey, AgentName, AgentStatus } from "./types";
import { join } from "node:path";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "./constants";

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
// 用全局 crypto.randomUUID()（浏览器 Web Crypto API + Node 19+ + Bun 均原生支持）
export function randomSessionId(): string {
  return `s-${crypto.randomUUID()}`;
}

/**
 * 计算会话的 pwd。
 *
 * - 普通项目会话：返回 project.cwd（行为不变）
 * - 默认工作区会话（projectId === SYSTEM_PROJECT_ID）：返回
 *   ${SYSTEM_PROJECT_CWD}/${session.createdAt}/，即 ~/.hiagent/workdir/<时间戳>/
 *
 * 这是**纯函数**，从 session.createdAt 推导，不依赖任何持久化的 cwd 字段。
 * 因此 kernel 启动时 mkdir 用的 ts 必须与 createSession 写入的 createdAt 严格一致
 * （详见 ws-server.ts 的 agent:prompt handler）。
 */
export function resolveSessionCwd(
  session: { projectId: string; createdAt: number },
  project: { cwd: string },
): string {
  if (session.projectId === SYSTEM_PROJECT_ID) {
    return join(SYSTEM_PROJECT_CWD, String(session.createdAt));
  }
  return project.cwd;
}
