import type { AgentName, AgentState, AgentStateKey } from "@hiagent/shared";
import { makeAgentStateKey } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import { PiRpcClient, type PiEvent, type PiRpcClientOpts } from "./pi-rpc-client";

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  onEvent: (key: AgentStateKey, e: PiEvent) => void;
  spawnFn?: PiRpcClientOpts["spawnFn"];
}

// 按 (projectId, agentName) 双 key 管理 Pi 进程生命周期。
// 同 key 复用同一个 PiRpcClient；不同 key 独立进程。cwd 取自 project.cwd。
export class AgentManager {
  private agents = new Map<AgentStateKey, PiRpcClient>();
  private states = new Map<AgentStateKey, AgentState>();

  constructor(private opts: AgentManagerOpts) {}

  async ensureStarted(projectId: string, agentName: AgentName): Promise<PiRpcClient> {
    const key = makeAgentStateKey(projectId, agentName);
    const existing = this.agents.get(key);
    if (existing) return existing;

    const { projects } = await this.opts.projectStore.load();
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);

    const client = new PiRpcClient({
      agentName,
      cwd: project.cwd,
      sessionId: `${projectId}-${agentName}`,  // pi-intercom 会话名
      spawnFn: this.opts.spawnFn,
      onEvent: (e) => {
        if (e.kind === "state") this.states.set(key, e.state);
        this.opts.onEvent(key, e);
      },
    });
    await client.start();
    this.agents.set(key, client);
    return client;
  }

  async abort(projectId: string, agentName: AgentName): Promise<void> {
    const key = makeAgentStateKey(projectId, agentName);
    const client = this.agents.get(key);
    if (client) await client.abort();
  }

  getState(key: AgentStateKey): AgentState | undefined {
    return this.states.get(key);
  }

  getAllStates(): Map<AgentStateKey, AgentState> {
    return new Map(this.states);
  }

  async disposeAll(): Promise<void> {
    for (const client of this.agents.values()) await client.dispose();
    this.agents.clear();
    this.states.clear();
  }
}
