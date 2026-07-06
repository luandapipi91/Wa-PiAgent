import { EventEmitter } from "node:events";
import type { AgentManager } from "./agent-manager";
import type { IntercomMonitor } from "./intercom-monitor";
import type { RPCEvent, WSEvent, ChatMessage } from "hiagent-shared";

interface IntercomToolArgs { to?: string; message?: string; text?: string; expectsReply?: boolean; replyTo?: string; }

export class StateAggregator extends EventEmitter {
  constructor(private agentManager: AgentManager, private intercomMonitor: IntercomMonitor) { super(); }

  start(): void {
    this.agentManager.on("event", ({ agentName, event }) => this.handleAgentEvent(agentName, event));
    this.agentManager.on("state", ({ agentName, state }) => {
      this.emit("ws:event", { type: "agent:state", agentName, state } as WSEvent);
    });
    this.intercomMonitor.on("reply", (r) => this.handleIntercomReply(r));
  }

  handleAgentEvent(agentName: string, event: RPCEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        if (event.toolName === "intercom") {
          const args = (event.args ?? {}) as IntercomToolArgs;
          if (args.expectsReply && args.to) {
            this.emit("ws:event", {
              type: "intercom:ask", from: agentName, to: args.to,
              messageId: event.toolCallId, text: args.message ?? args.text ?? "", startedAt: Date.now(),
            } as WSEvent);
          }
        }
        this.emit("ws:event", { type: "agent:tool", agentName, toolName: event.toolName, toolCallId: event.toolCallId, phase: "start" } as WSEvent);
        break;
      case "tool_execution_end": {
        const resultText = event.result?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        this.emit("ws:event", { type: "agent:tool", agentName, toolName: event.toolName, toolCallId: event.toolCallId, phase: "end", result: resultText } as WSEvent);
        break;
      }
      case "message_end": {
        const text = event.message.content?.map((c: any) => c.text ?? "").join("") ?? "";
        if (text) {
          const msg: ChatMessage = { id: `m${Date.now()}-${Math.random().toString(36).slice(2,6)}`, role: event.message.role === "user" ? "user" : "assistant", text, timestamp: Date.now() };
          this.emit("ws:event", { type: "agent:message", agentName, message: msg } as WSEvent);
        }
        break;
      }
    }
  }

  handleIntercomReply(r: { toAskMessageId: string; text: string; from: string }): void {
    this.emit("ws:event", { type: "intercom:reply", toAskMessageId: r.toAskMessageId, text: r.text } as WSEvent);
  }
}
