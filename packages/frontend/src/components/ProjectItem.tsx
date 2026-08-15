import {
	useState,
	useEffect,
	useRef,
	useLayoutEffect,
	type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
	SYSTEM_PROJECT_ID,
	type ProjectEntity,
	type SessionEntity,
} from "@wa-pi/shared";
import { SessionRow } from "./SessionRow";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Modal } from "./ui/Modal";
import { Icon } from "./ui/Icon";
import { api } from "../api-client";
import { useProjectUiStore } from "../store/project-ui";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { openInFileManagerLabel } from "../util/platform";
import { orderSessions } from "../util/projectOrder";
import { useTranslation } from "../i18n/useTranslation";
import { useSessionStore } from "../store/session";

interface Props {
	project: ProjectEntity;
	sessions: SessionEntity[];
	currentSessionId: string | null;
	selected: boolean;
	isNewSessionView?: boolean;
	onSelectSession: (id: string) => void;
	onNewSessionInProject: (projectId: string) => void;
	onSelectProject: (projectId: string) => void;
}

// 右键菜单坐标 + 目标
interface SessionMenuState {
	x: number;
	y: number;
	session: SessionEntity;
}
interface ProjectMenuState {
	x: number;
	y: number;
}

/** 将菜单坐标钳制到视口内，避免底部/右缘溢出（纯函数，便于测试） */
export function clampMenuPos(
	x: number,
	y: number,
	width: number,
	height: number,
	vw: number,
	vh: number,
	margin = 8,
): { left: number; top: number } {
	let top = y;
	let left = x;
	if (top + height > vh - margin) top = Math.max(margin, vh - height - margin);
	if (left + width > vw - margin) left = Math.max(margin, vw - width - margin);
	return { left, top };
}

/** 浮层渲染后（paint 前）测量尺寸并钳制坐标到视口内 */
export function useClampMenu(
	ref: React.RefObject<HTMLDivElement | null>,
	pos: { x: number; y: number } | null,
) {
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !pos) return;
		const { width, height } = el.getBoundingClientRect();
		const { left, top } = clampMenuPos(
			pos.x,
			pos.y,
			width,
			height,
			window.innerWidth,
			window.innerHeight,
		);
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	});
}

export function ProjectItem(props: Props) {
	const { t } = useTranslation();
	const expanded = useProjectUiStore((s) => s.isExpanded(props.project.id));
	const toggleProject = useProjectUiStore((s) => s.toggleProject);
	const setExpanded = useProjectUiStore((s) => s.setExpanded);
	// 会话右键菜单
	const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
	const sessionMenuRef = useRef<HTMLDivElement>(null);
	// 项目右键菜单
	const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
	const projectMenuRef = useRef<HTMLDivElement>(null);
	// 菜单渲染后钳制到视口内
	useClampMenu(sessionMenuRef, sessionMenu);
	useClampMenu(projectMenuRef, projectMenu);
	// 删除确认框
	const [deleteTarget, setDeleteTarget] = useState<
		SessionEntity | ProjectEntity | null
	>(null);
	const [deleteKind, setDeleteKind] = useState<"session" | "project" | null>(
		null,
	);
	// 重命名弹窗
	const [renameTarget, setRenameTarget] = useState<
		SessionEntity | ProjectEntity | null
	>(null);
	const [renameValue, setRenameValue] = useState("");

	const { project, sessions, currentSessionId, selected, isNewSessionView } =
		props;
	// 系统项目（默认工作区虚拟项目）：差异化图标/菜单
	const isSystem = project.id === SYSTEM_PROJECT_ID;
	// 会话列表顺序：点击项目名时按最近活跃 lastActivity 重排一次（带动画），
	// 其余时间保持稳定顺序（点击会话 selectSession 更新 lastActivity 不改变顺序）；
	// 新会话（SSE 推送/后台创建）按 lastActivity 倒序插入。
	const lastOrderRef = useRef<string[] | null>(null);
	// 重排信号（state）：点击项目名 +1 触发重渲染，mySessions 检测到变化时重排一次
	const [reorderSignal, setReorderSignal] = useState(0);
	const reorderConsumedRef = useRef(0);

	const mySessions = (() => {
		// IM 渠道会话（im- 前缀）归属 IM 页签；定时任务执行会话（sched- 前缀）独立于侧栏，
		// 均不在任务列表显示（kernel loadActive 已过滤，此处防御存量/竞态数据）
		const list = sessions.filter(
			(s) =>
				s.projectId === project.id &&
				!s.id.startsWith("im-") &&
				!s.id.startsWith("sched-"),
		);
		const shouldReorder = reorderSignal !== reorderConsumedRef.current;
		const ordered = orderSessions(list, lastOrderRef.current, shouldReorder);
		reorderConsumedRef.current = reorderSignal;
		lastOrderRef.current = ordered.map((s) => s.id);
		return ordered;
	})();

	// ---- 会话右键 ----
	const handleSessionContextMenu = (e: MouseEvent, session: SessionEntity) => {
		window.dispatchEvent(new CustomEvent("project-menu-close"));
		setSessionMenu({ x: e.clientX, y: e.clientY, session });
	};

	// ---- 项目右键 ----
	const handleProjectContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		window.dispatchEvent(new CustomEvent("project-menu-close"));
		setProjectMenu({ x: e.clientX, y: e.clientY });
	};

	// ---- popup 关闭（点击任意处 / ESC）----
	useEffect(() => {
		if (!sessionMenu && !projectMenu) return;
		const close = () => {
			setSessionMenu(null);
			setProjectMenu(null);
		};
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
	}, [sessionMenu, projectMenu]);

	// 跨组件菜单互斥：任何 ProjectItem 打开菜单时关闭自己的
	useEffect(() => {
		const onCloseAll = () => {
			setSessionMenu(null);
			setProjectMenu(null);
		};
		window.addEventListener("project-menu-close", onCloseAll);
		return () => window.removeEventListener("project-menu-close", onCloseAll);
	}, []);

	// ---- 操作 ----
	const handleRename = (session: SessionEntity) => {
		setSessionMenu(null);
		setRenameValue(session.title);
		setRenameTarget(session);
	};

	const handleProjectRename = () => {
		setProjectMenu(null);
		setRenameValue(project.name);
		setRenameTarget(project);
	};

	const handleRenameConfirm = () => {
		if (!renameTarget) return;
		const name = renameValue.trim();
		if (name) {
			if ("cwd" in renameTarget) {
				void api.patch(`/api/projects/${encodeURIComponent(renameTarget.id)}`, {
					name,
				});
			} else {
				void api.post(
					`/api/sessions/${encodeURIComponent(renameTarget.id)}/rename`,
					{ title: name },
				);
			}
		}
		setRenameTarget(null);
	};

	const handleRenameCancel = () => {
		setRenameTarget(null);
	};

	const handleDeleteClick = (session: SessionEntity) => {
		setSessionMenu(null);
		setDeleteTarget(session);
		setDeleteKind("session");
	};

	const handleProjectDeleteClick = () => {
		setProjectMenu(null);
		setDeleteTarget(project);
		setDeleteKind("project");
	};

	const handleOpenDir = () => {
		setProjectMenu(null);
		void api.post(
			`/api/projects/${encodeURIComponent(project.id)}/open-dir`,
			{},
		);
	};

	// 系统项目下的会话专属「在文件管理器中打开」：带 sessionId 让 main 打开会话所在目录
	const handleOpenSessionDir = (session: SessionEntity) => {
		setSessionMenu(null);
		void api.post(`/api/projects/${encodeURIComponent(project.id)}/open-dir`, {
			sessionId: session.id,
		});
	};

	const handleDeleteConfirm = () => {
		if (!deleteTarget) return;
		if (deleteKind === "session") {
			const sid = (deleteTarget as SessionEntity).id;
			void api.del(`/api/sessions/${encodeURIComponent(sid)}`);
			// 同步清理该会话的 composer 草稿（IndexedDB + store 内存）
			useComposerPrefsStore.getState().removeSessionPrefs(sid);
			useSessionStore.getState().removeSession(sid);
		} else {
			void api.del(
				`/api/projects/${encodeURIComponent((deleteTarget as ProjectEntity).id)}`,
			);
		}
		setDeleteTarget(null);
		setDeleteKind(null);
	};

	return (
		<motion.div
			layout="position"
			transition={{ layout: { duration: 0.25, ease: "easeOut" } }}
			data-testid={`project-${project.id}`}
		>
			{/* 项目头部 */}
			<div
				className={`flex items-center gap-1 px-2 py-1.5 rounded-sm transition-colors ${selected ? "bg-accent-soft" : "hover:bg-surface-hover"}`}
				onContextMenu={handleProjectContextMenu}
			>
				<button
					onClick={() => toggleProject(project.id)}
					className="text-tertiary w-5 text-[calc(18px*var(--font-scale))] flex items-center justify-center"
					data-testid={`project-toggle-${project.id}`}
				>
					{isSystem ? (
						<Icon name="home" size="1em" testId="project-icon-home" />
					) : expanded ? (
						<Icon
							name="folder-open"
							size="1em"
							testId="project-icon-folder-open"
						/>
					) : (
						<Icon name="folder" size="1em" testId="project-icon-folder" />
					)}
				</button>
				<button
					onClick={() => {
						// 项目处于折叠状态时，点击一次同时进入新建会话并展开列表；
						// 已展开时，在新会话界面且当前项目已被选中才展开/折叠，否则进入新建会话。
						// 展开/选中项目时触发一次会话重排（按 lastActivity），motion layout 播放位置动画。
						if (!expanded) {
							setReorderSignal((s) => s + 1);
							setExpanded(project.id, true);
							props.onSelectProject(project.id);
						} else if (isNewSessionView && selected) {
							toggleProject(project.id);
							return;
						} else {
							setReorderSignal((s) => s + 1);
							props.onSelectProject(project.id);
						}
					}}
					className="text-sm text-primary flex-1 min-w-0 truncate text-left transition-colors hover:text-brand"
					data-testid={`project-name-${project.id}`}
					title={project.cwd}
				>
					{isSystem ? t("projectList.systemProjectName") : project.name}
				</button>
			</div>

			{/* 会话列表：motion.div layout="position" 做重排 FLIP 动画（与「最近」视图一致，不叠加 opacity 淡入，避免展开时半透明与项目名叠透重叠） */}
			<AnimatePresence initial={false}>
				{expanded &&
					mySessions.map((s) => (
						<motion.div
							key={s.id}
							layout="position"
							transition={{
								layout: { duration: 0.25, ease: "easeOut" },
							}}
						>
							<SessionRow
								session={s}
								selected={s.id === currentSessionId}
								onSelect={props.onSelectSession}
								onContextMenu={handleSessionContextMenu}
							/>
						</motion.div>
					))}
			</AnimatePresence>

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
						{isSystem && (
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
						)}
					</div>,
					document.body,
				)}

			{/* 项目右键菜单 */}
			{projectMenu &&
				createPortal(
					<div
						ref={projectMenuRef}
						className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
						style={{
							left: projectMenu.x,
							top: projectMenu.y,
							background: "var(--surface)",
							boxShadow: "var(--shadow-lg)",
							minWidth: 140,
						}}
						onClick={(e) => e.stopPropagation()}
						data-testid="project-context-menu"
					>
						<button
							onClick={handleOpenDir}
							className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
							data-testid="menu-open-dir"
						>
							{openInFileManagerLabel({
								mac: t("common.openInFinder"),
								windows: t("common.openInExplorer"),
								linux: t("common.openInFileManager"),
							})}
						</button>
						{!isSystem && (
							<>
								<button
									onClick={handleProjectRename}
									className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
									data-testid="menu-rename-project"
								>
									{t("projectItem.ctxRenameProject")}
								</button>
								<button
									onClick={handleProjectDeleteClick}
									className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
									data-testid="menu-delete-project"
								>
									{t("projectItem.ctxDeleteProject")}
								</button>
							</>
						)}
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
							{"cwd" in renameTarget
								? t("projectItem.renameProjectTitle")
								: t("projectItem.renamePromptTitle")}
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
					title={
						deleteKind === "session"
							? t("projectItem.ctxDeleteChat")
							: t("projectItem.ctxDeleteProject")
					}
					message={
						deleteKind === "session"
							? t("projectItem.deleteSessionMsg", {
									title: (deleteTarget as SessionEntity).title,
								})
							: t("projectItem.deleteProjectMsg", {
									name: (deleteTarget as ProjectEntity).name,
								})
					}
					confirmText={t("common.delete")}
					danger
					onConfirm={handleDeleteConfirm}
					onCancel={() => {
						setDeleteTarget(null);
						setDeleteKind(null);
					}}
				/>
			)}
		</motion.div>
	);
}
