import { create } from "zustand";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { send } from "../ws-instance";

interface AgentsState {
  configs: Partial<Record<AgentName, AgentConfig>>;
  loadConfig: (name: AgentName) => void;
  setConfig: (name: AgentName, c: AgentConfig) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  configs: {},
  loadConfig: (name) => send({ type: "agent:config:get", agentName: name }),
  setConfig: (name, c) => set(st => ({ configs: { ...st.configs, [name]: c } })),
}));
