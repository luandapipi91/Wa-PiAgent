import { AGENT_DEFS, aggregateAgentState } from "@hiagent/shared";
import type { AgentName, AgentStatus } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { selectPendingAsks } from "../store/ask";
import { STATUS_COLORS } from "../theme/colors";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

interface Props { onSelectAgent: (name: AgentName) => void; }

export function AgentListSection({ onSelectAgent }: Props) {
  const sessions = useProjectsStore(s => s.sessions);
  const statusBySession = useSessionStore(s => s.statusBySession);
  const messagesBySession = useSessionStore(s => s.messagesBySession);
  // agent 状态点 = 名下所有会话的活状态聚合（kernel 无 agent 级状态推送，从会话级派生）：
  // 任一会话有待回答提问 → blocked；否则任一会话运行中 → thinking；否则 idle
  const statusOf = (name: AgentName): AgentStatus =>
    aggregateAgentState(
      sessions
        .filter(s => s.primaryAgent === name)
        .map(s => ({
          name,
          status: selectPendingAsks(messagesBySession[s.id] ?? []).length > 0
            ? ("blocked" as const)
            : (statusBySession[s.id] ?? "idle"),
        }))
    );
  return (
    <div className="mb-2 mt-1">
      <div className="text-[11px] font-bold text-tertiary px-2 pb-1 uppercase tracking-wide">智能体</div>
      {NAMES.map(name => {
        const status = statusOf(name);
        return (
          <button
            key={name}
            onClick={() => onSelectAgent(name)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors hover:bg-surface-hover text-left"
            data-testid={`agent-${name}`}
          >
            <span className="text-base">{AGENT_DEFS[name].emoji}</span>
            <span className="text-[13px] text-secondary flex-1">{AGENT_DEFS[name].label}</span>
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: STATUS_COLORS[status] }}
              data-testid={`status-${name}`}
            />
          </button>
        );
      })}
    </div>
  );
}
