import { create } from "zustand";
import type { AgentConfig, AgentName, AgentState, AgentStateKey, AgentStatus } from "@hiagent/shared";
import { aggregateAgentState } from "@hiagent/shared";
import { send } from "../ws-instance";

interface AgentsState {
  states: Record<AgentStateKey, AgentState>;
  configs: Partial<Record<AgentName, AgentConfig>>;
  setState: (key: AgentStateKey, s: AgentState) => void;
  loadConfig: (name: AgentName) => void;
  setConfig: (name: AgentName, c: AgentConfig) => void;
  getGlobalState: (name: AgentName) => AgentStatus;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  states: {},
  configs: {},
  setState: (key, s) => set(st => ({ states: { ...st.states, [key]: s } })),
  loadConfig: (name) => send({ type: "agent:config:get", agentName: name }),
  setConfig: (name, c) => set(st => ({ configs: { ...st.configs, [name]: c } })),
  getGlobalState: (name) => {
    const all = Object.entries(get().states)
      .filter(([k]) => k.endsWith(`:${name}`))
      .map(([, v]) => v);
    return aggregateAgentState(all);
  },
}));
