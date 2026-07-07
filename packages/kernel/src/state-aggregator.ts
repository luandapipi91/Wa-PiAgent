import type {
  WSServerEvent, AgentStateKey, AgentName,
} from "@hiagent/shared";
import { parseAgentStateKey } from "@hiagent/shared";
import type { PiEvent } from "./pi-rpc-client";
import type { SessionStore } from "./session-store";
import type { AgentManager } from "./agent-manager";

export interface StateAggregatorOpts {
  sessionStore: SessionStore;   // Task 5 随 broker-proxy 一起清（asks 部分还在用）
  agentManager: AgentManager;
  onServerEvent: (e: WSServerEvent) => void;
}

export class StateAggregator {
  constructor(private opts: StateAggregatorOpts) {}

  routePiEvent(key: AgentStateKey, e: PiEvent): void {
    const { projectId, agentName } = parseAgentStateKey(key);
    switch (e.kind) {
      case "message": {
        const sessionId = e.message.sessionId ?? "";
        this.opts.onServerEvent({
          type: "agent:message", projectId,
          sessionId,
          agentName, message: e.message,
        });
        break;
      }
      case "state": {
        this.opts.onServerEvent({
          type: "agent:state", projectId, agentName, state: e.state,
        });
        break;
      }
      case "error": {
        // pi prompt 失败等错误透传给前端（带 agent 上下文，便于定位）
        this.opts.onServerEvent({
          type: "error",
          message: `[${agentName}] ${e.message}`,
        });
        break;
      }
      // intercom ask/reply 由 broker-proxy/intercom-monitor 处理（Task 5 删除）
    }
  }

  // 启动时全量推送（前端连上后调用）
  async snapshot(): Promise<WSServerEvent[]> {
    // Task 12 的 WS server 启动时调用，此处给最小实现
    return [];
  }
}
