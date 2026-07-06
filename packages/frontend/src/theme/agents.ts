import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";

export function agentEmoji(name: AgentName): string {
  return AGENT_DEFS[name].emoji;
}

export function agentGradient(name: AgentName): string {
  const [a, b] = AGENT_DEFS[name].gradient;
  return `linear-gradient(135deg, ${a}, ${b})`;
}
