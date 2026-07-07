import type { AgentName, AgentState, AgentStateKey } from "@hiagent/shared";
import { makeAgentStateKey, HIAGENT_PI_AGENT_DIR } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import type { ConfigStore } from "./config-store";
import { PiRpcClient, type PiEvent, type PiRpcClientOpts } from "./pi-rpc-client";

export interface AgentManagerOpts {
  projectStore: ProjectStore;
  configStore?: ConfigStore;  // 可选：测试用 mock spawn 不需 config；生产传真实 ConfigStore
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
    if (!project.cwd) throw new Error(`项目工作目录缺失: ${project.name ?? projectId}`);

    // 读 agent 配置（系统提示词/工具/模型），传给 pi spawn
    const config = this.opts.configStore ? await this.opts.configStore.getAgent(agentName) : null;

    const client = new PiRpcClient({
      agentName,
      cwd: project.cwd,
      sessionId: `${projectId}-${agentName}`,  // pi-intercom 会话名
      config: config ?? undefined,
      spawnFn: this.opts.spawnFn,
      env: { PI_CODING_AGENT_DIR: HIAGENT_PI_AGENT_DIR },  // 让 Pi 把数据存到 .hiagent/pi-agent
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
    for (const [, client] of this.agents) {
      await client.dispose();
    }
    this.agents.clear();
    this.states.clear();
  }
}
