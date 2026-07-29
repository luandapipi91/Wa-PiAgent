import { agentDefOf } from "@wa-pi/shared";
import type { AgentName } from "@wa-pi/shared";

export function agentEmoji(name: AgentName): string {
  return agentDefOf(name).emoji;
}

export function agentGradient(name: AgentName): string {
  const [a, b] = agentDefOf(name).gradient;
  return `linear-gradient(135deg, ${a}, ${b})`;
}
