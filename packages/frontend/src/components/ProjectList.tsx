import { useProjectsStore } from "../store/projects";
import { SYSTEM_PROJECT_ID } from "@hiagent/shared";
import type { View } from "../App";
import { ProjectItem } from "./ProjectItem";

interface Props {
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  currentView?: View;
}

export function ProjectList(props: Props) {
  const { projects, sessions, currentSessionId, currentProjectId } = useProjectsStore();
  const isNewSessionView = props.currentView === "new-session";
  // 过滤掉系统项目（默认工作区），它由 Sidebar 的"默认"独立区单独渲染，避免重复
  const userProjects = projects.filter(p => p.id !== SYSTEM_PROJECT_ID);
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="text-[11px] font-bold text-tertiary px-2 py-1 border-t border-hairline mt-2 uppercase tracking-wide">项目</div>
      {userProjects.map(p => (
        <ProjectItem
          key={p.id}
          project={p}
          sessions={sessions}
          currentSessionId={currentSessionId}
          selected={p.id === currentProjectId}
          isNewSessionView={isNewSessionView}
          onSelectSession={props.onSelectSession}
          onNewSessionInProject={props.onNewSessionInProject}
          onSelectProject={props.onSelectProject}
        />
      ))}
      <button
        onClick={props.onNewProject}
        className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand"
        data-testid="new-project-btn"
      >＋ 新建项目</button>
    </div>
  );
}
