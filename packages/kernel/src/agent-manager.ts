import { EventEmitter } from "node:events";
import type { AgentConfig, AgentState, RPCEvent } from "hiagent-shared";
import { ConfigStore } from "./config-store";
import { PiRpcClient } from "./pi-rpc-client";

export class AgentManager extends EventEmitter {
  private clients = new Map<string, PiRpcClient>();
  private states = new Map<string, AgentState>();

  constructor(private configStore: ConfigStore, private cwd: string) { super(); }

  async listAvailableAgents(): Promise<AgentConfig[]> { return this.configStore.listAgents(); }

  async ensureStarted(name: string): Promise<PiRpcClient> {
    let client = this.clients.get(name);
    if (client) return client;
    const config = await this.configStore.getAgent(name);
    if (!config) throw new Error(`Agent "${name}" not found`);
    client = new PiRpcClient(config, this.cwd);
    client.on("event", (event: RPCEvent) => {
      this.updateState(name, event);
      this.emit("event", { agentName: name, event });
    });
    client.on("exit", () => {
      this.clients.delete(name);
      this.states.set(name, { status: "idle" });
      this.emit("state", { agentName: name, state: { status: "idle" } });
    });
    await client.start();
    this.clients.set(name, client);
    this.states.set(name, { status: "idle", model: config.model });
    return client;
  }

  get(name: string): PiRpcClient | undefined { return this.clients.get(name); }
  getState(name: string): AgentState { return this.states.get(name) ?? { status: "idle" }; }
  stop(name: string): void { this.clients.get(name)?.stop(); this.clients.delete(name); }
  stopAll(): void { for (const c of this.clients.values()) c.stop(); this.clients.clear(); }

  private updateState(name: string, event: RPCEvent): void {
    const prev = this.states.get(name) ?? { status: "idle" };
    let next = prev;
    if (event.type === "agent_start" || event.type === "turn_start") next = { ...prev, status: "thinking" };
    else if (event.type === "agent_end") next = { ...prev, status: "idle" };
    if (next !== prev) {
      this.states.set(name, next);
      this.emit("state", { agentName: name, state: next });
    }
  }
}
