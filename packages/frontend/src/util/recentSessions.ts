import {
	SYSTEM_PROJECT_ID,
	type ProjectEntity,
	type SessionEntity,
} from "@wa-pi/shared";

export const MAX_RECENT_SESSIONS = 100;

export interface RecentSessionItem {
	session: SessionEntity;
	projectName: string;
	dayKey: string;
	dayLabel: string;
}

type Translate = (key: string) => string;

export const startOfDay = (ts: number): string => {
	const d = new Date(ts);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

const isSameDay = (a: number, b: number): boolean =>
	startOfDay(a) === startOfDay(b);

/** 时间刻度文案：今天 / 昨天 / M月D日，跨年加年份 */
export function dayLabelOf(ts: number, now: number, t: Translate): string {
	if (isSameDay(ts, now)) return t("recentSessions.today");
	if (isSameDay(ts, now - 86400000)) return t("recentSessions.yesterday");
	const d = new Date(ts);
	const n = new Date(now);
	const md = `${d.getMonth() + 1}月${d.getDate()}日`;
	return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/**
 * 最近会话时间线：过滤（非 IM、未删除）→ 按 lastActivity 倒序
 * → 截断 MAX_RECENT_SESSIONS → 标注项目名与按天刻度
 */
export function buildRecentSessions(
	projects: ProjectEntity[],
	sessions: SessionEntity[],
	now: number,
	t: Translate,
): RecentSessionItem[] {
	const projectNameOf = (pid: string) =>
		pid === SYSTEM_PROJECT_ID
			? t("projectList.systemProjectName")
			: (projects.find((p) => p.id === pid)?.name ?? pid);
	const tsOf = (s: SessionEntity) => s.lastActivity || s.createdAt || 0;

	return sessions
		.filter(
			(s) =>
				!s.deletedAt && !s.id.startsWith("im-") && !s.id.startsWith("sched-"),
		)
		.sort((a, b) => tsOf(b) - tsOf(a))
		.slice(0, MAX_RECENT_SESSIONS)
		.map((s) => ({
			session: s,
			projectName: projectNameOf(s.projectId),
			dayKey: startOfDay(tsOf(s)),
			dayLabel: dayLabelOf(tsOf(s), now, t),
		}));
}
