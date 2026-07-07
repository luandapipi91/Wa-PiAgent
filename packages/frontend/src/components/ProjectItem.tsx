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

// 右键菜单的坐标 + 目标 session
interface MenuState {
  x: number;
  y: number;
  session: SessionEntity;
}

export function ProjectItem(props: Props) {
  const [expanded, setExpanded] = useState(true);
  // 右键 popup 菜单状态（null = 关闭）
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 删除确认框状态（null = 关闭）
  const [deleteTarget, setDeleteTarget] = useState<SessionEntity | null>(null);

  const { project, sessions, currentSessionId, selected } = props;
  // 倒序：最新活动（lastActivity 大）的在顶部
  const mySessions = sessions
    .filter(s => s.projectId === project.id)
    .sort((a, b) => b.lastActivity - a.lastActivity);

  // 右键回调：记录坐标 + session，打开 popup
  const handleContextMenu = (e: MouseEvent, session: SessionEntity) => {
    setMenu({ x: e.clientX, y: e.clientY, session });
  };

  // popup 打开时：点击任意处 / ESC 关闭（监听一次）
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // 延迟一帧绑定，避免触发 popup 的那次 contextmenu/click 立即关掉自己
    const id = requestAnimationFrame(() => {
      window.addEventListener("click", close);
      window.addEventListener("keydown", onKey);
    });
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // 重命名：window.prompt（最小成本，后端 session:rename 已就绪）
  const handleRename = (session: SessionEntity) => {
    setMenu(null);
    const title = window.prompt("重命名会话", session.title);
    if (title && title.trim()) {
      send({ type: "session:rename", sessionId: session.id, title: title.trim() });
    }
  };

  // 删除：弹 confirm 确认
  const handleDeleteClick = (session: SessionEntity) => {
    setMenu(null);
    setDeleteTarget(session);
  };
  const handleDeleteConfirm = () => {
    if (deleteTarget) {
      send({ type: "session:delete", sessionId: deleteTarget.id });
    }
    setDeleteTarget(null);
  };

  return (
    <div data-testid={`project-${project.id}`}>
      <div
        className="flex items-center gap-1 px-2 py-1.5 rounded"
        style={selected ? { background: "rgba(137,180,250,0.15)" } : undefined}
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
      {expanded && mySessions.map(s => (
        <SessionRow
          key={s.id}
          session={s}
          selected={s.id === currentSessionId}
          onSelect={props.onSelectSession}
          onContextMenu={handleContextMenu}
        />
      ))}

      {/* 右键 popup 菜单（Portal 到 body 避免被侧边栏 overflow-hidden 裁剪） */}
      {menu && createPortal(
        <div
          className="fixed z-50 rounded-md py-1 text-sm"
          style={{
            left: menu.x,
            top: menu.y,
            background: "#313244",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            minWidth: 140,
          }}
          onClick={e => e.stopPropagation()}  // 点菜单项不立即触发 window.click 关闭（由项内 setMenu 关）
          data-testid="session-context-menu"
        >
          <button
            onClick={() => handleRename(menu.session)}
            className="w-full text-left px-3 py-1.5 text-text hover:bg-[#45475a]"
            data-testid="menu-rename"
          >重命名会话</button>
          <button
            onClick={() => handleDeleteClick(menu.session)}
            className="w-full text-left px-3 py-1.5 hover:bg-[#45475a]"
            style={{ color: "#f38ba8" }}
            data-testid="menu-delete"
          >删除聊天</button>
        </div>,
        document.body
      )}

      {/* 删除确认框 */}
      {deleteTarget && (
        <ConfirmDialog
          title="删除聊天"
          message={`确定删除会话「${deleteTarget.title}」吗？此操作不可撤销。`}
          confirmText="删除"
          danger
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
