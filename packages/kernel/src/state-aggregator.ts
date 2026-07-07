import type {
  WSServerEvent, AgentStateKey, AgentName, AskItem, ChatMessage,
} from "@hiagent/shared";
import { parseAgentStateKey } from "@hiagent/shared";
import type { PiEvent } from "./pi-rpc-client";
import type { SessionStore } from "./session-store";
import type { AgentManager } from "./agent-manager";

export interface StateAggregatorOpts {
  sessionStore: SessionStore;
  agentManager: AgentManager;
  onServerEvent: (e: WSServerEvent) => void;
}

export class StateAggregator {
  constructor(private opts: StateAggregatorOpts) {}

  routePiEvent(key: AgentStateKey, e: PiEvent): void {
    const { projectId, agentName } = parseAgentStateKey(key);
    switch (e.kind) {
      case "message": {
        const msg: ChatMessage = { ...e.message };
        this.opts.onServerEvent({
          type: "agent:message", projectId,
          sessionId: msg.sessionId, agentName, message: msg,
        });
        // 异步持久化（不阻塞事件流）
        this.opts.sessionStore.appendMessage(msg.sessionId, msg).catch(() => {});
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
      // intercom ask/reply 由 routeAsk/routeReply 处理（来自 IntercomMonitor）
    }
  }

  routeAsk(ask: AskItem): void {
    this.opts.onServerEvent({ type: "intercom:ask", sessionId: ask.sessionId, ask });
    this.opts.sessionStore.appendAsk(ask.sessionId, ask).catch(() => {});
  }

  routeReply(askMessageId: string, sessionId: string): void {
    this.opts.onServerEvent({ type: "intercom:reply", sessionId, askMessageId });
    this.opts.sessionStore.resolveAsk(sessionId, askMessageId).catch(() => {});
  }

  // 启动时全量推送（前端连上后调用）
  async snapshot(): Promise<WSServerEvent[]> {
    // Task 12 的 WS server 启动时调用，此处给最小实现
    return [];
  }
}
