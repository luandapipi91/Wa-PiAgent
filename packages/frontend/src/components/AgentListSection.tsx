import { useAgentsStore } from "../store/agents";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
  onMore: () => void;
}

/** 智能体折叠栏：显示「智能体 n ›」，点击打开宫格弹窗（复用 AgentGalleryModal） */
export function AgentListSection({ onMore }: Props) {
  const { t } = useTranslation();
  const agents = useAgentsStore((s) => s.list);
  return (
    <button
      onClick={onMore}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors hover:bg-surface-hover text-left cursor-pointer"
      data-testid="agent-collapsed"
    >
      <span className="text-[calc(13px*var(--font-scale))] font-semibold text-secondary flex-1 min-w-0 truncate">
        {t("agentList.sectionTitle")}
      </span>
      <span className="bg-surface-hover rounded px-1.5 text-[calc(11px*var(--font-scale))] text-tertiary flex-shrink-0">
        {agents.length}
      </span>
      <span className="text-tertiary flex-shrink-0">›</span>
    </button>
  );
}
