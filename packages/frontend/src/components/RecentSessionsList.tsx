import { useMemo } from "react";
import { useProjectsStore } from "../store/projects";
import { useTranslation } from "../i18n/useTranslation";
import { buildRecentSessions } from "../util/recentSessions";
import { SessionRow } from "./SessionRow";

interface Props {
  onSelectSession: (id: string) => void;
}

/** 「最近」时间线视图：全部项目会话按时间倒序，按天刻度分组，每行标注项目名 */
export function RecentSessionsList({ onSelectSession }: Props) {
  const { t } = useTranslation();
  const projects = useProjectsStore((s) => s.projects);
  const sessions = useProjectsStore((s) => s.sessions);
  const currentSessionId = useProjectsStore((s) => s.currentSessionId);

  const items = useMemo(
    () => buildRecentSessions(projects, sessions, Date.now(), (k) => t(k)),
    [projects, sessions, t],
  );

  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex items-center justify-center" data-testid="recent-sessions-list">
        <span className="text-[calc(13px*var(--font-scale))] text-tertiary" data-testid="recent-sessions-empty">
          {t("recentSessions.empty")}
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden" data-testid="recent-sessions-list">
      {items.map((item, i) => {
        const showSep = i === 0 || item.dayKey !== items[i - 1].dayKey;
        return (
          <div key={item.session.id}>
            {showSep && (
              <div
                className="px-2 pt-2 pb-1 text-[calc(11px*var(--font-scale))] font-semibold text-tertiary"
                data-testid={`day-sep-${item.dayKey}`}
              >
                {item.dayLabel}
              </div>
            )}
            <SessionRow
              session={item.session}
              selected={item.session.id === currentSessionId}
              onSelect={onSelectSession}
              subtitle={item.projectName}
            />
          </div>
        );
      })}
    </div>
  );
}
