import type { SessionEntity } from "@hiagent/shared";
import { formatRelativeTime } from "@hiagent/shared";
import { agentEmoji } from "../theme/agents";

interface Props {
  session: SessionEntity;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function SessionRow({ session, selected, onSelect }: Props) {
  return (
    <button
      onClick={() => onSelect(session.id)}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm"
      style={{
        borderLeft: selected ? "2px solid #89b4fa" : "2px solid transparent",
        background: selected ? "rgba(137,180,250,0.15)" : "transparent",
      }}
      data-testid={`session-${session.id}`}
    >
      <span>{agentEmoji(session.primaryAgent)}</span>
      <span className="text-text flex-1 truncate">{session.title}</span>
      <span className="text-xs text-overlay">{formatRelativeTime(session.lastActivity)}</span>
    </button>
  );
}
