import { create } from "zustand";
import type { AgentConfig, AgentName, SessionEntity } from "@hiagent/shared";
import { send } from "../ws-instance";

/** 最近使用排序：各 agent 名下会话最大 lastActivity 倒序；无会话的按名称序排最后 */
export function topAgentsByRecency(
  agents: AgentConfig[], sessions: SessionEntity[], n: number,
): AgentConfig[] {
  const lastOf = new Map<string, number>();
  for (const s of sessions) {
    lastOf.set(s.primaryAgent, Math.max(lastOf.get(s.primaryAgent) ?? 0, s.lastActivity));
  }
  return [...agents]
    .filter(a => a.displayName)  // 防御：过滤 displayName 为空的条目（如内置 agent .md 用 name 字段）
    .sort((x, y) => (lastOf.get(y.displayName) ?? -1) - (lastOf.get(x.displayName) ?? -1) || x.displayName.localeCompare(y.displayName))
    .slice(0, n);
}

interface AgentsState {
  list: AgentConfig[];
  configs: Record<string, AgentConfig>;
  loadAll: () => void;
  setList: (agents: AgentConfig[]) => void;
  createAgent: (displayName: string) => void;
  deleteAgent: (name: string) => void;
  loadConfig: (name: AgentName) => void;
  setConfig: (name: AgentName, c: AgentConfig) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  list: [],
  configs: {},
  loadAll: () => send({ type: "agent:list" }),
  setList: (agents) => set({ list: agents }),
  createAgent: (displayName) => send({ type: "agent:create", displayName }),
  deleteAgent: (name) => send({ type: "agent:delete", name }),
  loadConfig: (name) => send({ type: "agent:config:get", agentName: name }),
  setConfig: (name, c) => set(st => ({ configs: { ...st.configs, [name]: c } })),
}));
