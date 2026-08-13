import {
	useState,
	useEffect,
	useRef,
	useMemo,
	type ReactNode,
	type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { SessionEntity } from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { useTranslation } from "../i18n/useTranslation";
import { buildRecentSessions, startOfDay } from "../util/recentSessions";
import { SessionRow } from "./SessionRow";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Modal } from "./ui/Modal";
import { api } from "../api-client";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useSessionStore } from "../store/session";
import { openInFileManagerLabel } from "../util/platform";
import { useClampMenu } from "./ProjectItem";

/** 重排/刻度位置动画时长（秒） */
const LAYOUT_ANIM_DURATION = 0.25;

interface Props {
	onSelectSession: (id: string) => void;
	onNewSession: () => void;
}

interface SessionMenuState {
	x: number;
	y: number;
	session: SessionEntity;
}

/** 「最近」时间线视图：全部项目会话按时间倒序，按天刻度分组，每行标注项目名；支持会话右键菜单（重命名/删除/打开目录） */
export function RecentSessionsList({ onSelectSession, onNewSession }: Props) {
	const { t } = useTranslation();
	const projects = useProjectsStore((s) => s.projects);
	const sessions = useProjectsStore((s) => s.sessions);
	const currentSessionId = useProjectsStore((s) => s.currentSessionId);

	// 会话右键菜单
	const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
	const sessionMenuRef = useRef<HTMLDivElement>(null);
	useClampMenu(sessionMenuRef, sessionMenu);
	// 重命名弹窗
	const [renameTarget, setRenameTarget] = useState<SessionEntity | null>(null);
	const [renameValue, setRenameValue] = useState("");
	// 删除确认框
	const [deleteTarget, setDeleteTarget] = useState<SessionEntity | null>(null);

	const items = useMemo(
		() => buildRecentSessions(projects, sessions, Date.now(), (k) => t(k)),
		[projects, sessions, t],
	);

	// 点击会话：触发 selectSession（乐观更新 lastActivity 导致重排），motion layout 播放 FLIP 位移动画
	const handleClick = (id: string) => {
		onSelectSession(id);
	};

	// ---- 会话右键 ----
	const handleSessionContextMenu = (e: MouseEvent, session: SessionEntity) => {
		window.dispatchEvent(new CustomEvent("project-menu-close"));
		setSessionMenu({ x: e.clientX, y: e.clientY, session });
	};

	// popup 关闭（点击任意处 / ESC）
	useEffect(() => {
		if (!sessionMenu) return;
		const close = () => setSessionMenu(null);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		const id = setTimeout(() => {
			document.addEventListener("click", close);
			document.addEventListener("keydown", onKey);
		}, 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("click", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [sessionMenu]);

	// 跨组件菜单互斥：任何组件打开菜单时关闭自己的
	useEffect(() => {
		const onCloseAll = () => setSessionMenu(null);
		window.addEventListener("project-menu-close", onCloseAll);
		return () => window.removeEventListener("project-menu-close", onCloseAll);
	}, []);

	// ---- 操作 ----
	const handleRename = (session: SessionEntity) => {
		setSessionMenu(null);
		setRenameValue(session.title);
		setRenameTarget(session);
	};

	const handleRenameConfirm = () => {
		if (!renameTarget) return;
		const name = renameValue.trim();
		if (name) {
			void api.post(
				`/api/sessions/${encodeURIComponent(renameTarget.id)}/rename`,
				{ title: name },
			);
		}
		setRenameTarget(null);
	};

	const handleRenameCancel = () => setRenameTarget(null);

	const handleDeleteClick = (session: SessionEntity) => {
		setSessionMenu(null);
		setDeleteTarget(session);
	};

	const handleDeleteConfirm = () => {
		if (!deleteTarget) return;
		const sid = deleteTarget.id;
		void api.del(`/api/sessions/${encodeURIComponent(sid)}`);
		// 同步清理该会话的 composer 草稿（IndexedDB + store 内存）
		useComposerPrefsStore.getState().removeSessionPrefs(sid);
		useSessionStore.getState().removeSession(sid);
		setDeleteTarget(null);
	};

	// 「在文件管理器中打开」：带 sessionId 让 main 打开会话所在目录（系统项目会话为会话子目录，普通项目会话为项目根目录）
	const handleOpenSessionDir = (session: SessionEntity) => {
		setSessionMenu(null);
		void api.post(
			`/api/projects/${encodeURIComponent(session.projectId)}/open-dir`,
			{ sessionId: session.id },
		);
	};

	const todayKey = startOfDay(Date.now());

	return (
		<div
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
				<>
					{items.flatMap((item, i): ReactNode[] => {
					const isToday = item.dayKey === todayKey;
					// 今天的刻度已在顶部渲染，非今天的才渲染自己的刻度；
					// 刻度与会话行均加 motion.div layout="position"，重排时做 FLIP 位移动画（刻度不再跟着跳）。
					const showSep =
						!isToday && (i === 0 || item.dayKey !== items[i - 1].dayKey);
					const nodes: ReactNode[] = [];
					if (showSep) {
						nodes.push(
							<motion.div
								key={`sep-${item.dayKey}`}
								layout="position"
								transition={{
									layout: {
										duration: LAYOUT_ANIM_DURATION,
										ease: "easeOut",
									},
								}}
							>
								<div
									className="px-2 pt-2 pb-1 text-[calc(11px*var(--font-scale))] font-semibold text-tertiary"
									data-testid={`day-sep-${item.dayKey}`}
								>
									{item.dayLabel}
								</div>
							</motion.div>,
						);
					}
					nodes.push(
						<motion.div
							key={item.session.id}
							layout="position"
							transition={{
								layout: {
									duration: LAYOUT_ANIM_DURATION,
									ease: "easeOut",
								},
							}}
						>
							<SessionRow
								session={item.session}
								selected={item.session.id === currentSessionId}
								onSelect={handleClick}
								onContextMenu={handleSessionContextMenu}
								subtitle={item.projectName}
							/>
						</motion.div>,
					);
					return nodes;
					})}
				</>
			)}

			{/* 会话右键菜单 */}
			{sessionMenu &&
				createPortal(
					<div
						ref={sessionMenuRef}
						className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
						style={{
							left: sessionMenu.x,
							top: sessionMenu.y,
							background: "var(--surface)",
							boxShadow: "var(--shadow-lg)",
							minWidth: 140,
						}}
						onClick={(e) => e.stopPropagation()}
						data-testid="session-context-menu"
					>
						<button
							onClick={() => handleRename(sessionMenu.session)}
							className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
							data-testid="menu-rename"
						>
							{t("projectItem.ctxRenameSession")}
						</button>
						<button
							onClick={() => handleDeleteClick(sessionMenu.session)}
							className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
							data-testid="menu-delete"
						>
							{t("projectItem.ctxDeleteChat")}
						</button>
						<button
							onClick={() => handleOpenSessionDir(sessionMenu.session)}
							className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
							data-testid="menu-open-session-dir"
						>
							{openInFileManagerLabel({
								mac: t("common.openInFinder"),
								windows: t("common.openInExplorer"),
								linux: t("common.openInFileManager"),
							})}
						</button>
					</div>,
					document.body,
				)}

			{/* 重命名弹窗 */}
			{renameTarget && (
				<Modal
					onClose={handleRenameCancel}
					width={400}
					closeOnOverlayClick={false}
					data-testid="rename-dialog"
				>
					<div className="p-4 border-b border-hairline">
						<div className="text-primary font-bold text-sm">
							{t("projectItem.renamePromptTitle")}
						</div>
					</div>
					<div className="p-4">
						<input
							className="w-full px-2.5 py-1.5 rounded-md"
							style={{
								background: "var(--canvas)",
								border: "1px solid var(--hairline)",
								color: "var(--text-primary)",
							}}
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleRenameConfirm();
							}}
							autoFocus
							data-testid="rename-input"
						/>
					</div>
					<div className="flex justify-end gap-2 p-3 border-t border-hairline">
						<button
							onClick={handleRenameCancel}
							className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
							data-testid="rename-cancel"
						>
							{t("common.cancel")}
						</button>
						<button
							onClick={handleRenameConfirm}
							className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
							style={{ background: "var(--brand)", color: "var(--on-brand)" }}
							data-testid="rename-ok"
						>
							{t("common.confirm")}
						</button>
					</div>
				</Modal>
			)}

			{/* 删除确认框 */}
			{deleteTarget && (
				<ConfirmDialog
					title={t("projectItem.ctxDeleteChat")}
					message={t("projectItem.deleteSessionMsg", {
						title: deleteTarget.title,
					})}
					confirmText={t("common.delete")}
					danger
					onConfirm={handleDeleteConfirm}
					onCancel={() => setDeleteTarget(null)}
				/>
			)}
		</div>
	);
}
