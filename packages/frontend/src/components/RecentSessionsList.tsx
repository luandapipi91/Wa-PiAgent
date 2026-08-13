import { useMemo, useEffect, type ReactNode } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useProjectsStore } from "../store/projects";
import { useTranslation } from "../i18n/useTranslation";
import { buildRecentSessions, startOfDay } from "../util/recentSessions";
import { SessionRow } from "./SessionRow";

/** 重排动画时长（ms），与 auto-animate duration 一致，用于点击后延时恢复禁用 */
const ANIM_DURATION = 250;

interface Props {
	onSelectSession: (id: string) => void;
	onNewSession: () => void;
}

/** 「最近」时间线视图：全部项目会话按时间倒序，按天刻度分组，每行标注项目名 */
export function RecentSessionsList({ onSelectSession, onNewSession }: Props) {
	const { t } = useTranslation();
	const projects = useProjectsStore((s) => s.projects);
	const sessions = useProjectsStore((s) => s.sessions);
	const currentSessionId = useProjectsStore((s) => s.currentSessionId);

	// auto-animate：默认禁用，仅用户点击会话触发的重排才动画（后台 SSE 推送/初始加载不动画）。
	// 但 disable() 会 clearTimeout 掉 updatePos 记录 coords 的 setTimeout，导致首次点击无 coords 基线、
	// 元素被误判为「新增」走 enter 动画（scale 缩放）而非 FLIP 位移动画。故延迟 disable，
	// 让 coords 先记录完成（updatePos 最长 debounce 250ms）。
	const [listRef, setAnimateEnabled] = useAutoAnimate<HTMLDivElement>({
		duration: ANIM_DURATION,
		easing: "ease-out",
	});
	useEffect(() => {
		const t = setTimeout(() => setAnimateEnabled(false), 300);
		return () => clearTimeout(t);
	}, [setAnimateEnabled]);

	const items = useMemo(
		() => buildRecentSessions(projects, sessions, Date.now(), (k) => t(k)),
		[projects, sessions, t],
	);

	// 点击会话：临时启用动画 → 触发 selectSession（乐观更新 lastActivity 导致重排）→ 动画结束后恢复禁用
	const handleClick = (id: string) => {
		setAnimateEnabled(true);
		onSelectSession(id);
		// 动画最长是 enter（duration*1.5=375ms），用 2 倍 duration 覆盖，避免提前 disable cancel 未完成的动画导致闪现
		window.setTimeout(() => setAnimateEnabled(false), ANIM_DURATION * 2);
	};

	const todayKey = startOfDay(Date.now());

	return (
		<div
			ref={listRef}
			className="flex-1 overflow-y-auto overflow-x-hidden"
			data-testid="recent-sessions-list"
		>
			{/* 今天刻度：始终显示，右侧放 ＋新建会话 入口 */}
			<div className="flex items-center justify-between px-2 pt-2 pb-1">
				<span className="text-[calc(11px*var(--font-scale))] font-semibold text-tertiary">
					{t("recentSessions.today")}
				</span>
				<button
					onClick={onNewSession}
					className="text-[calc(11px*var(--font-scale))] text-tertiary hover:opacity-80 cursor-pointer"
					data-testid="recent-new-session"
				>
					{t("recentSessions.newSession")}
				</button>
			</div>
			{items.length === 0 ? (
				<div className="flex items-center justify-center py-8">
					<span
						className="text-[calc(13px*var(--font-scale))] text-tertiary"
						data-testid="recent-sessions-empty"
					>
						{t("recentSessions.empty")}
					</span>
				</div>
			) : (
				items.flatMap((item, i): ReactNode[] => {
					const isToday = item.dayKey === todayKey;
					// 今天的刻度已在顶部渲染，非今天的才渲染自己的刻度；
					// 刻度与行均作为容器直接子元素（稳定 key），让 auto-animate 对两者位置变化统一做 FLIP 动画。
					const showSep =
						!isToday && (i === 0 || item.dayKey !== items[i - 1].dayKey);
					const nodes: ReactNode[] = [];
					if (showSep) {
						nodes.push(
							<div
								key={`sep-${item.dayKey}`}
								className="px-2 pt-2 pb-1 text-[calc(11px*var(--font-scale))] font-semibold text-tertiary"
								data-testid={`day-sep-${item.dayKey}`}
							>
								{item.dayLabel}
							</div>,
						);
					}
					nodes.push(
						<SessionRow
							key={item.session.id}
							session={item.session}
							selected={item.session.id === currentSessionId}
							onSelect={handleClick}
							subtitle={item.projectName}
						/>,
					);
					return nodes;
				})
			)}
		</div>
	);
}
