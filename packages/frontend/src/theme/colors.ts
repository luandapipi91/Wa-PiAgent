import type { AgentStatus } from "@hiagent/shared";

export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#6c7086",
  thinking: "#89b4fa",
  blocked: "#fab387",
};
