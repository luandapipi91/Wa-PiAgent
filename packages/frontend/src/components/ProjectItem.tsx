import { useState, useEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
	SYSTEM_PROJECT_ID,
	type ProjectEntity,
	type SessionEntity,
} from "@wa-pi/shared";
import { SessionRow } from "./SessionRow";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Icon } from "./ui/Icon";
import { api } from "../api-client";
import { useProjectUiStore } from "../store/project-ui";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { openInFileManagerLabel } from "../util/platform";

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

export function ProjectItem(props: Props) {
	const expanded = useProjectUiStore((s) => s.isExpanded(props.project.id));
	const toggleProject = useProjectUiStore((s) => s.toggleProject);
	const setExpanded = useProjectUiStore((s) => s.setExpanded);
	// 会话右键菜单
	const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
	// 项目右键菜单
	const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
	// 删除确认框
	const [deleteTarget, setDeleteTarget] = useState<
		SessionEntity | ProjectEntity | null
	>(null);
	const [deleteKind, setDeleteKind] = useState<"session" | "project" | null>(
		null,
	);

	const { project, sessions, currentSessionId, selected, isNewSessionView } =
		props;
	// 系统项目（默认工作区虚拟项目）：差异化图标/菜单
	const isSystem = project.id === SYSTEM_PROJECT_ID;
	// 会话列表稳定顺序：点击会话（selectSession 更新 lastActivity）不改变列表顺序；
	// 仅当项目从折叠到展开时，按最近活跃 lastActivity 重排一次。
	const lastOrderRef = useRef<string[] | null>(null);
	const prevExpandedRef = useRef<boolean>(expanded);
	const mySessions = (() => {
		// IM 渠道会话（im- 前缀）归属 IM 页签，不在任务列表显示
		const list = sessions.filter((s) => s.projectId === project.id && !s.id.startsWith("im-"));
		// 折叠 → 展开：重新按 lastActivity 倒序重排
		if (expanded && !prevExpandedRef.current) {
			lastOrderRef.current = [...list]
				.sort((a, b) => b.lastActivity - a.lastActivity)
				.map((s) => s.id);
		}
		prevExpandedRef.current = expanded;

		if (!lastOrderRef.current) {
			lastOrderRef.current = [...list]
				.sort((a, b) => b.lastActivity - a.lastActivity)
				.map((s) => s.id);
			return [...list].sort((a, b) => b.lastActivity - a.lastActivity);
		}

		// 稳定顺序：按 lastOrderRef 输出；新会话（不在缓存顺序中）按 lastActivity 倒序插入
		const byId = new Map(list.map((s) => [s.id, s]));
		const ordered: SessionEntity[] = [];
		for (const id of lastOrderRef.current) {
			const s = byId.get(id);
			if (s) ordered.push(s);
		}
		const known = new Set(lastOrderRef.current);
		const newcomers = list
			.filter((s) => !known.has(s.id))
			.sort((a, b) => b.lastActivity - a.lastActivity);
		for (const n of newcomers) {
			const idx = ordered.findIndex((s) => s.lastActivity < n.lastActivity);
			if (idx === -1) ordered.push(n);
			else ordered.splice(idx, 0, n);
		}
		lastOrderRef.current = ordered.map((s) => s.id);
		return ordered;
	})();

	// ---- 会话右键 ----
	const handleSessionContextMenu = (e: MouseEvent, session: SessionEntity) => {
		setSessionMenu({ x: e.clientX, y: e.clientY, session });
	};

	// ---- 项目右键 ----
	const handleProjectContextMenu = (e: MouseEvent) => {
		e.preventDefault();
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

	// ---- 操作 ----
	const handleRename = (session: SessionEntity) => {
		setSessionMenu(null);
		const title = window.prompt("重命名会话", session.title);
		if (title && title.trim()) {
			void api.post(`/api/sessions/${encodeURIComponent(session.id)}/rename`, {
				title: title.trim(),
			});
		}
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
		} else {
			void api.del(
				`/api/projects/${encodeURIComponent((deleteTarget as ProjectEntity).id)}`,
			);
		}
		setDeleteTarget(null);
		setDeleteKind(null);
	};

	return (
		<div data-testid={`project-${project.id}`}>
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
						if (!expanded) {
							setExpanded(project.id, true);
							props.onSelectProject(project.id);
						} else if (isNewSessionView && selected) {
							toggleProject(project.id);
						} else {
							props.onSelectProject(project.id);
						}
					}}
					className="text-sm text-primary flex-1 min-w-0 truncate text-left transition-colors hover:text-brand"
					data-testid={`project-name-${project.id}`}
					title={project.cwd}
				>
					{project.name}
				</button>
			</div>

			{/* 会话列表 */}
			{expanded &&
				mySessions.map((s) => (
					<SessionRow
						key={s.id}
						session={s}
						selected={s.id === currentSessionId}
						onSelect={props.onSelectSession}
						onContextMenu={handleSessionContextMenu}
					/>
				))}

			{/* 会话右键菜单 */}
			{sessionMenu &&
				createPortal(
					<div
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
							重命名会话
						</button>
						<button
							onClick={() => handleDeleteClick(sessionMenu.session)}
							className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
							data-testid="menu-delete"
						>
							删除聊天
						</button>
						{isSystem && (
							<button
								onClick={() => handleOpenSessionDir(sessionMenu.session)}
								className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
								data-testid="menu-open-session-dir"
							>
								{openInFileManagerLabel()}
							</button>
						)}
					</div>,
					document.body,
				)}

			{/* 项目右键菜单 */}
			{projectMenu &&
				createPortal(
					<div
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
							{openInFileManagerLabel()}
						</button>
						{!isSystem && (
							<button
								onClick={handleProjectDeleteClick}
								className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
								data-testid="menu-delete-project"
							>
								删除项目
							</button>
						)}
					</div>,
					document.body,
				)}

			{/* 删除确认框 */}
			{deleteTarget && (
				<ConfirmDialog
					title={deleteKind === "session" ? "删除聊天" : "删除项目"}
					message={
						deleteKind === "session"
							? `确定删除会话「${(deleteTarget as SessionEntity).title}」吗？此操作不可撤销。`
							: `确定删除项目「${(deleteTarget as ProjectEntity).name}」吗？该项目下的所有会话也会被一并删除，此操作不可撤销。`
					}
					confirmText="删除"
					danger
					onConfirm={handleDeleteConfirm}
					onCancel={() => {
						setDeleteTarget(null);
						setDeleteKind(null);
					}}
				/>
			)}
		</div>
	);
}
