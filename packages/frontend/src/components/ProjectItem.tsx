import { useState, useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { SessionRow } from "./SessionRow";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { send } from "../ws-instance";

interface Props {
  project: ProjectEntity;
  sessions: SessionEntity[];
  currentSessionId: string | null;
  selected: boolean;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
}

// 右键菜单坐标 + 目标
interface SessionMenuState { x: number; y: number; session: SessionEntity; }
interface ProjectMenuState { x: number; y: number; }

export function ProjectItem(props: Props) {
  const [expanded, setExpanded] = useState(true);
  // 会话右键菜单
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  // 项目右键菜单
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  // 删除确认框
  const [deleteTarget, setDeleteTarget] = useState<SessionEntity | ProjectEntity | null>(null);
  const [deleteKind, setDeleteKind] = useState<"session" | "project" | null>(null);

  const { project, sessions, currentSessionId, selected } = props;
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
      send({ type: "session:rename", sessionId: session.id, title: title.trim() });
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
    send({ type: "project:open-dir", projectId: project.id });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    if (deleteKind === "session") {
      send({ type: "session:delete", sessionId: (deleteTarget as SessionEntity).id });
    } else {
      send({ type: "project:delete", projectId: (deleteTarget as ProjectEntity).id });
    }
    setDeleteTarget(null);
    setDeleteKind(null);
  };

  return (
    <div data-testid={`project-${project.id}`}>
      {/* 项目头部 */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 rounded"
        style={selected ? { background: "rgba(137,180,250,0.15)" } : undefined}
        onContextMenu={handleProjectContextMenu}
      >
        <button onClick={() => setExpanded(e => !e)} className="text-overlay w-4">
          {expanded ? "▼" : "▶"}
        </button>
        <button
          onClick={() => props.onSelectProject(project.id)}
          className="text-sm text-text flex-1 truncate text-left hover:text-blue"
          data-testid={`project-name-${project.id}`}
          title={project.cwd}
        >{project.name}</button>
        <button
          onClick={() => props.onNewSessionInProject(project.id)}
          className="text-overlay hover:text-blue px-1"
          data-testid={`new-in-${project.id}`}
        >＋</button>
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
          className="fixed z-50 rounded-md py-1 text-sm"
          style={{
            left: sessionMenu.x, top: sessionMenu.y,
            background: "#313244",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)", minWidth: 140,
          }}
          onClick={e => e.stopPropagation()}
          data-testid="session-context-menu"
        >
          <button
            onClick={() => handleRename(sessionMenu.session)}
            className="w-full text-left px-3 py-1.5 text-text hover:bg-[#45475a]"
            data-testid="menu-rename"
          >重命名会话</button>
          <button
            onClick={() => handleDeleteClick(sessionMenu.session)}
            className="w-full text-left px-3 py-1.5 hover:bg-[#45475a]"
            style={{ color: "#f38ba8" }}
            data-testid="menu-delete"
          >删除聊天</button>
        </div>,
        document.body
      )}

      {/* 项目右键菜单 */}
      {projectMenu && createPortal(
        <div
          className="fixed z-50 rounded-md py-1 text-sm"
          style={{
            left: projectMenu.x, top: projectMenu.y,
            background: "#313244",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)", minWidth: 140,
          }}
          onClick={e => e.stopPropagation()}
          data-testid="project-context-menu"
        >
          <button
            onClick={handleOpenDir}
            className="w-full text-left px-3 py-1.5 text-text hover:bg-[#45475a]"
            data-testid="menu-open-dir"
          >查看文件夹</button>
          <button
            onClick={handleProjectDeleteClick}
            className="w-full text-left px-3 py-1.5 hover:bg-[#45475a]"
            style={{ color: "#f38ba8" }}
            data-testid="menu-delete-project"
          >删除项目</button>
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
