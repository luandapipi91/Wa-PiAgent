import { AGENT_DEFS } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";
import { STATUS_COLORS } from "../theme/colors";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

interface Props { onSelectAgent: (name: AgentName) => void; }

export function AgentListSection({ onSelectAgent }: Props) {
  // 订阅 states 触发重渲染（getGlobalState 内部读 states），否则状态点不会更新
  useAgentsStore(s => s.states);
  const getGlobalState = useAgentsStore.getState().getGlobalState;
  return (
    <div className="mb-3">
      <div className="text-xs text-overlay px-2 mb-1">👥 我的智能体</div>
      {NAMES.map(name => {
        const status = getGlobalState(name);
        return (
          <button
            key={name}
            onClick={() => onSelectAgent(name)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface text-left"
            data-testid={`agent-${name}`}
          >
            <span className="text-base">{AGENT_DEFS[name].emoji}</span>
            <span className="text-sm text-text flex-1">{AGENT_DEFS[name].label}</span>
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: STATUS_COLORS[status] }}
              data-testid={`status-${name}`}
            />
          </button>
        );
      })}
    </div>
  );
}
