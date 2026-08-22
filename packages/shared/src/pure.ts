import type { AgentState, AgentStateKey, AgentName, AgentStatus } from "./types";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "./constants";

// 相对时间格式化：刚刚 / 2m / 1h / 昨天 / Nd / M/D
// labels 可选，用于本地化"刚刚"和"昨天"（默认中文，保持导出函数兼容）。
export function formatRelativeTime(
  ts: number,
  now: number = Date.now(),
  labels?: { justNow?: string; yesterday?: string },
): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return labels?.justNow ?? "刚刚";
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day === 1) return labels?.yesterday ?? "昨天";
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
 * 计算会话的 cwd。
 *
 * - 普通项目会话：返回 project.cwd（行为不变）
 * - 默认工作区会话（projectId === SYSTEM_PROJECT_ID）：返回
 *   ${project.cwd}/${session.createdAt}，即 <默认工作区根>/<时间戳>
 *
 * 默认工作区根目录**只**用持久化的 project.cwd（kernel 运行时本机路径，/api/projects
 * 返回的 __system__ 项目记录，kernel 启动时 ensureSystemProject 写入），绝不回退
 * SYSTEM_PROJECT_CWD 常量——前端 bundle 里的该常量来自构建机注入的
 * HOME/USERPROFILE/WA_PI_DIR，一旦被污染（如 Windows 上跑 macOS 构建的包，常量是
 * /Users/pipi/.pi/agent/workdir），回退就等于稳定地请求错误路径（listDir 返回
 * fs:error → 默认工作区文件树空白）。project.cwd 缺失时返回空串，由调用方处理
 * （前端 ExplorerPanel 空串渲染空态不请求；kernel 调用点均有 !project.cwd 前置校验）。
 *
 * 目录名仍由 session.createdAt 推导，kernel 启动时 mkdir 用的 ts 必须与
 * createSession 写入的 createdAt 严格一致（详见 ws-server.ts 的 agent:prompt handler）。
 */
export function resolveSessionCwd(
  session: { projectId: string; createdAt: number },
  project: { cwd: string },
): string {
  if (session.projectId === SYSTEM_PROJECT_ID) {
    // 绝不回退常量：空 cwd 时返回空串，宁可不出文件树也不请求错误路径
    return project.cwd ? `${project.cwd}/${session.createdAt}` : "";
  }
  return project.cwd;
}
