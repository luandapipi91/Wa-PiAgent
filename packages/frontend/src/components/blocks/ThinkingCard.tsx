import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";

/** 思考过程卡片：流式中展开实时可见，整轮结束自动折叠并弱化 */
export function ThinkingCard({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !isStreaming });
  const { t } = useTranslation();
  return (
    <ProcessCard
      tone="accent"
      icon={<Icon name="thought" />}
      title={t("blocks.thinking.title")}
      meta={isStreaming ? (<><Spinner /><span>{t("blocks.thinking.thinking")}</span></>) : t("blocks.thinking.done")}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId="thinking-panel"
    >
      <div className="italic text-tertiary whitespace-pre-wrap break-words">{thinking}</div>
    </ProcessCard>
  );
}
