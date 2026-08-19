import { useAgentsStore } from "../store/agents";
import { api } from "../api-client";
import { Modal } from "./ui/Modal";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
  sessionId: string;
  onClose: () => void;
}

// avatarColor 形如 "#06b6d4-#3b82f6"（渐变）或单色；还原为 CSS background（同 AgentSwitcher）
function avatarBackground(color?: string): string | undefined {
  if (!color) return undefined;
  const [c1, c2] = color.split("-").map((s) => s.trim());
  return c2 ? `linear-gradient(135deg, ${c1}, ${c2})` : c1;
}

// 会话主智能体已删除（kernel 回 agent_missing）时的重选弹窗：
// 恢复流程非主动切换——不弹缓存确认框，点击即发送 session:set-agent；失败消息由用户手动重发
export function AgentMissingModal({ sessionId, onClose }: Props) {
  const agents = useAgentsStore((s) => s.list);
  const { t } = useTranslation();
  const pick = (name: string) => {
    void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/set-agent`, {
      agentName: name,
    });
    onClose();
  };
  return (
    <Modal onClose={onClose} width={400} data-testid="agent-missing-modal">
      <div className="p-4 border-b border-hairline flex items-center justify-between">
        <div className="text-primary font-bold text-sm">
          {t("agentMissing.title")}
        </div>
        <button
          onClick={onClose}
          className="text-tertiary text-xs"
          data-testid="agent-missing-close"
          aria-label={t("common.close")}
        >
          ✕
        </button>
      </div>
      <div className="px-4 pt-3 text-sm text-secondary leading-relaxed">
        {t("agentMissing.message")}
      </div>
      <div className="p-2 max-h-[300px] overflow-y-auto">
        {agents.map((a) => (
          <button
            type="button"
            key={a.displayName}
            data-testid={`agent-missing-item-${a.displayName}`}
            onClick={() => pick(a.displayName)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left border-0 bg-transparent transition-colors text-secondary hover:bg-surface-hover"
          >
            <span
              className="w-[22px] h-[22px] rounded-sm flex items-center justify-center text-[calc(12px*var(--font-scale))] flex-none"
              style={{ background: avatarBackground(a.avatarColor) }}
            >
              {a.avatar}
            </span>
            <span className="text-[calc(12px*var(--font-scale))] text-primary">
              {a.displayName}
            </span>
          </button>
        ))}
        {agents.length === 0 && (
          <div className="px-3 py-3.5 text-center text-tertiary text-[calc(12px*var(--font-scale))]">
            {t("agentMissing.empty")}
          </div>
        )}
      </div>
    </Modal>
  );
}
