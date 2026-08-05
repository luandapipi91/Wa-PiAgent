import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { Icon } from "../ui/Icon";

/** 思考过程卡片：流式中展开实时可见，整轮结束自动折叠并弱化 */
export function ThinkingCard({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !isStreaming });
  return (
    <ProcessCard
      tone="accent"
      icon={<Icon name="thought" />}
      title="思考过程"
      meta={isStreaming ? (<><Spinner /><span>思考中…</span></>) : "已完成"}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId="thinking-panel"
    >
      <div className="italic text-tertiary whitespace-pre-wrap break-words">{thinking}</div>
    </ProcessCard>
  );
}
