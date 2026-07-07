import type {
  WSServerEvent, AgentStateKey,
} from "@hiagent/shared";
import { parseAgentStateKey } from "@hiagent/shared";
import type { PiEvent } from "./pi-rpc-client";
import type { AgentManager } from "./agent-manager";

export interface StateAggregatorOpts {
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
          agentName,
        });
        break;
      }
      // intercom ask/reply 现走 Pi 原生 pi-intercom，StateAggregator 不再旁路处理
    }
  }

  // 启动时全量推送（前端连上后调用）
  async snapshot(): Promise<WSServerEvent[]> {
    // Task 12 的 WS server 启动时调用，此处给最小实现
    return [];
  }
}
