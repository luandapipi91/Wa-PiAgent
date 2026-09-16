import { useRef, useEffect, type MouseEvent } from "react";
import type { SessionEntity } from "@wa-pi/shared";
import { formatRelativeTime } from "@wa-pi/shared";
import { agentEmoji } from "../theme/agents";
import { useSessionStore } from "../store/session";
import { selectPendingAsks } from "../store/ask";
import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
  session: SessionEntity;
  selected: boolean;
  onSelect: (id: string) => void;
  // 右键菜单回调：阻止默认行为后把坐标和 session 交给父组件
  onContextMenu?: (e: MouseEvent, session: SessionEntity) => void;
  // 标题下方次级标注（如「最近」视图的项目名）；缺省不渲染
  subtitle?: string;
}

export function SessionRow({ session, selected, onSelect, onContextMenu, subtitle }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();
  // 该会话是否有未读新回复（后台收到回复完成时置位，进入会话清掉）
  const unread = useSessionStore(s => !!s.unreadBySession[session.id]);
  // 该会话是否正在运行（agent 处理中）：运行时右侧时间位换成 loading 转圈，结束恢复时间
  const isRunning = useSessionStore(s => s.statusBySession[session.id] === "thinking");
  // 该会话是否有 pending ask（等用户回答）：有则显示问号而非 spinner
  const hasPendingAsk = useSessionStore(s =>
    selectPendingAsks(s.messagesBySession[session.id] ?? []).length > 0,
  );

  // 用原生事件监听确保 preventDefault 能阻止浏览器右键菜单
  useEffect(() => {
    const el = btnRef.current;
    if (!el || !onContextMenu) return;
    const handler = (e: Event) => {
      e.preventDefault();
      onContextMenu(e as unknown as MouseEvent, session);
    };
    el.addEventListener("contextmenu", handler);
    return () => el.removeEventListener("contextmenu", handler);
  }, [onContextMenu, session]);

  return (
    <button
      ref={btnRef}
      onClick={() => onSelect(session.id)}
      className="relative w-full flex items-center gap-2 px-2 py-1.5 text-left text-[calc(13px*var(--font-scale))] rounded-sm transition-colors hover:bg-surface-hover"
      style={{
        borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
        background: selected ? "var(--accent-soft)" : undefined,
        color: selected ? "var(--accent)" : "var(--text-secondary)",
        fontWeight: selected ? 600 : 400,
      }}
      data-testid={`session-${session.id}`}
    >
      <span className="text-sm">{agentEmoji(session.primaryAgent)}</span>
      <span className="flex-1 min-w-0 flex flex-col justify-center">
        <span className="truncate">{session.title}</span>
        {subtitle && (
          <span
            className="text-[calc(11px*var(--font-scale))] text-tertiary truncate"
            data-testid={`session-subtitle-${session.id}`}
          >
            {subtitle}
          </span>
        )}
      </span>
      {/* 右侧：pending ask 显示问号；运行中显示 loading 转圈；否则显示相对时间 */}
      {hasPendingAsk ? (
        <span
          data-testid={`session-awaiting-${session.id}`}
          aria-label={t("sessionRow.awaitingAnswer")}
          className="flex-shrink-0 inline-flex items-center justify-center text-accent"
          style={{ width: 14, height: 14 }}
        >
          <Icon name="question" size={13} />
        </span>
      ) : isRunning ? (
        <span
          data-testid={`session-running-${session.id}`}
          aria-label={t("common.statusRunning")}
          className="flex-shrink-0 inline-flex items-center justify-center"
          style={{ width: 14, height: 14 }}
        >
          <span
            className="inline-block rounded-full"
            style={{ width: 11, height: 11, border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }}
          />
        </span>
      ) : (
        <span className="text-[calc(11px*var(--font-scale))] text-tertiary flex-shrink-0">{formatRelativeTime(session.lastActivity, Date.now(), { justNow: t("sessionRow.justNow"), yesterday: t("sessionRow.yesterday") })}</span>
      )}
      {/* 未读新回复：右上角小圆点 */}
      {unread && (
        <span
          data-testid={`unread-tag-${session.id}`}
          aria-label={t("sessionRow.hasNewReply")}
          className="absolute select-none pointer-events-none"
          style={{ top: 2, right: 2, width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }}
        />
      )}
    </button>
  );
}
