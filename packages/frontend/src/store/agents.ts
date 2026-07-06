import { create } from "zustand";
import type { AgentConfig, AgentState } from "hiagent-shared";

interface AgentsStore {
  list: AgentConfig[];
  states: Record<string, AgentState>;
  setList: (a: AgentConfig[]) => void;
  updateState: (n: string, s: AgentState) => void;
}
export const useAgents = create<AgentsStore>((set) => ({
  list: [], states: {},
  setList: (agents) => set({ list: agents }),
  updateState: (name, state) => set((s) => ({ states: { ...s.states, [name]: state } })),
}));
