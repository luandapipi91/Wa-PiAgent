import type { AgentName, AgentStatus } from "@hiagent/shared";

export interface CanvasNodeData {
  agentName: AgentName;
  status: AgentStatus;
  tokenCount?: number;
}
