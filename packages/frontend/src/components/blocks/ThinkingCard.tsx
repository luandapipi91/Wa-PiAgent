import { memo } from "react";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { Linkify } from "./linkify";
import { useSettled } from "./useSettled";
import { useTranslation } from "../../i18n/useTranslation";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { Icon } from "../ui/Icon";

/** 思考过程卡片：流式中展开实时可见，整轮结束自动折叠并弱化;
 *  开启「回复过程默认折叠」后，流式中也默认折叠（用户仍可手动展开）。
 *  memo：同消息内其他块流式更新时 props 不变，整块跳过（thinking 往往是回复中
 *  最长部分，Linkify 全文正则 split 不能被连坐重渲染）。
 *  流式降级：isStreaming 且未停顿（useSettled）→ 纯文本不跑 Linkify，
 *  停顿 500ms 或结束后恢复链接化（每帧 O(全文) 正则 split 的卡顿热点）。 */
export const ThinkingCard = memo(function ThinkingCard({
  thinking,
  isStreaming,
  idleMs = 500,
}: {
  thinking: string;
  isStreaming?: boolean;
  idleMs?: number;
}) {
  const collapseProcessByDefault = useUiPrefsStore(
    (s) => s.collapseProcessByDefault,
  );
  const { open, toggle } = useAutoCollapse({
    isStreaming,
    isDone: !isStreaming,
    defaultCollapsed: collapseProcessByDefault,
  });
  const { t } = useTranslation();
  const settled = useSettled(thinking, idleMs);
  return (
    <ProcessCard
      tone="accent"
      icon={<Icon name="thought" />}
      title={t("blocks.thinking.title")}
      meta={
        isStreaming ? (
          <>
            <Spinner />
            <span>{t("blocks.thinking.thinking")}</span>
          </>
        ) : (
          t("blocks.thinking.done")
        )
      }
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId="thinking-panel"
    >
      <div className="italic text-tertiary whitespace-pre-wrap break-words">
        {isStreaming && !settled ? thinking : <Linkify text={thinking} />}
      </div>
    </ProcessCard>
  );
});
