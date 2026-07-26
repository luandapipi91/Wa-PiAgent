import { useState, useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { SYSTEM_PROJECT_ID, type ProjectEntity, type SessionEntity } from "@hiagent/shared";
import { SessionRow } from "./SessionRow";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { api } from "../api-client";
import { useProjectUiStore } from "../store/project-ui";

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
interface SessionMenuState { x: number; y: number; session: SessionEntity; }
interface ProjectMenuState { x: number; y: number; }

export function ProjectItem(props: Props) {
  const expanded = useProjectUiStore(s => s.isExpanded(props.project.id));
  const toggleProject = useProjectUiStore(s => s.toggleProject);
  // 会话右键菜单
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  // 项目右键菜单
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  // 删除确认框
  const [deleteTarget, setDeleteTarget] = useState<SessionEntity | ProjectEntity | null>(null);
  const [deleteKind, setDeleteKind] = useState<"session" | "project" | null>(null);

  const { project, sessions, currentSessionId, selected, isNewSessionView } = props;
  // 系统项目（默认工作区虚拟项目）：差异化图标/菜单
  const isSystem = project.id === SYSTEM_PROJECT_ID;
  const mySessions = sessions
    .filter(s => s.projectId === project.id)
    .sort((a, b) => b.lastActivity - a.lastActivity);

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
    const close = () => { setSessionMenu(null); setProjectMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
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
      void api.post(`/api/sessions/${encodeURIComponent(session.id)}/rename`, { title: title.trim() });
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
    void api.post(`/api/projects/${encodeURIComponent(project.id)}/open-dir`, {});
  };

  // 系统项目下的会话专属"打开工作目录"：带 sessionId 让 main 打开会话所在目录
  const handleOpenSessionDir = (session: SessionEntity) => {
    setSessionMenu(null);
    void api.post(`/api/projects/${encodeURIComponent(project.id)}/open-dir`, { sessionId: session.id });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    if (deleteKind === "session") {
      void api.del(`/api/sessions/${encodeURIComponent((deleteTarget as SessionEntity).id)}`);
    } else {
      void api.del(`/api/projects/${encodeURIComponent((deleteTarget as ProjectEntity).id)}`);
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
          className="text-tertiary w-5 text-xs flex items-center justify-center"
          data-testid={`project-toggle-${project.id}`}
        >
          {isSystem ? "🏠" : (expanded ? "📂" : "📁")}
        </button>
        <button
          onClick={() => {
            // 不在新会话界面时，点击项目名先进入该项目的新会话；
            // 已经在新会话界面且当前项目已被选中时，点击项目名才展开/折叠。
            if (isNewSessionView && selected) {
              toggleProject(project.id);
            } else {
              props.onSelectProject(project.id);
            }
          }}
          className="text-sm text-primary flex-1 min-w-0 truncate text-left transition-colors hover:text-brand"
          data-testid={`project-name-${project.id}`}
          title={project.cwd}
        >{project.name}</button>
      </div>

      {/* 会话列表 */}
      {expanded && mySessions.map(s => (
        <SessionRow
          key={s.id}
          session={s}
          selected={s.id === currentSessionId}
          onSelect={props.onSelectSession}
          onContextMenu={handleSessionContextMenu}
        />
      ))}

      {/* 会话右键菜单 */}
      {sessionMenu && createPortal(
        <div
          className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
          style={{
            left: sessionMenu.x, top: sessionMenu.y,
            background: "var(--surface)",
            boxShadow: "var(--shadow-lg)", minWidth: 140,
          }}
          onClick={e => e.stopPropagation()}
          data-testid="session-context-menu"
        >
          <button
            onClick={() => handleRename(sessionMenu.session)}
            className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
            data-testid="menu-rename"
          >重命名会话</button>
          <button
            onClick={() => handleDeleteClick(sessionMenu.session)}
            className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
            data-testid="menu-delete"
          >删除聊天</button>
          {isSystem && (
            <button
              onClick={() => handleOpenSessionDir(sessionMenu.session)}
              className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
              data-testid="menu-open-session-dir"
            >打开工作目录</button>
          )}
        </div>,
        document.body
      )}

      {/* 项目右键菜单 */}
      {projectMenu && createPortal(
        <div
          className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
          style={{
            left: projectMenu.x, top: projectMenu.y,
            background: "var(--surface)",
            boxShadow: "var(--shadow-lg)", minWidth: 140,
          }}
          onClick={e => e.stopPropagation()}
          data-testid="project-context-menu"
        >
          <button
            onClick={handleOpenDir}
            className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
            data-testid="menu-open-dir"
          >查看文件夹</button>
          {!isSystem && (
            <button
              onClick={handleProjectDeleteClick}
              className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
              data-testid="menu-delete-project"
            >删除项目</button>
          )}
        </div>,
        document.body
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
          onCancel={() => { setDeleteTarget(null); setDeleteKind(null); }}
        />
      )}
    </div>
  );
}
