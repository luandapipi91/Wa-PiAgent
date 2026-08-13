import { useMemo, useEffect, type ReactNode } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useProjectsStore } from "../store/projects";
import { useTranslation } from "../i18n/useTranslation";
import { buildRecentSessions } from "../util/recentSessions";
import { SessionRow } from "./SessionRow";

/** 重排动画时长（ms），与 auto-animate duration 一致，用于点击后延时恢复禁用 */
const ANIM_DURATION = 250;

interface Props {
	onSelectSession: (id: string) => void;
}

/** 「最近」时间线视图：全部项目会话按时间倒序，按天刻度分组，每行标注项目名 */
export function RecentSessionsList({ onSelectSession }: Props) {
	const { t } = useTranslation();
	const projects = useProjectsStore((s) => s.projects);
	const sessions = useProjectsStore((s) => s.sessions);
	const currentSessionId = useProjectsStore((s) => s.currentSessionId);

	// auto-animate：默认禁用，仅用户点击会话触发的重排才动画（后台 SSE 推送/初始加载不动画，避免持续抖动）
	const [listRef, setAnimateEnabled] = useAutoAnimate<HTMLDivElement>({
		duration: ANIM_DURATION,
		easing: "ease-out",
	});
	useEffect(() => {
		setAnimateEnabled(false);
	}, [setAnimateEnabled]);

	const items = useMemo(
		() => buildRecentSessions(projects, sessions, Date.now(), (k) => t(k)),
		[projects, sessions, t],
	);

	// 点击会话：临时启用动画 → 触发 selectSession（乐观更新 lastActivity 导致重排）→ 动画结束后恢复禁用
	const handleClick = (id: string) => {
		setAnimateEnabled(true);
		onSelectSession(id);
		window.setTimeout(() => setAnimateEnabled(false), ANIM_DURATION + 80);
	};

	if (items.length === 0) {
		return (
			<div
				className="flex-1 overflow-y-auto overflow-x-hidden flex items-center justify-center"
				data-testid="recent-sessions-list"
			>
				<span
					className="text-[calc(13px*var(--font-scale))] text-tertiary"
					data-testid="recent-sessions-empty"
				>
					{t("recentSessions.empty")}
				</span>
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			className="flex-1 overflow-y-auto overflow-x-hidden"
			data-testid="recent-sessions-list"
		>
			{items.flatMap((item, i): ReactNode[] => {
				const showSep = i === 0 || item.dayKey !== items[i - 1].dayKey;
				// 刻度与行均作为容器直接子元素（稳定 key），让 auto-animate 对两者位置变化统一做 FLIP 动画，
				// 避免刻度作为孙元素在重排时瞬移闪烁（“今天”文字跟着跳）。
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
			})}
		</div>
	);
}
