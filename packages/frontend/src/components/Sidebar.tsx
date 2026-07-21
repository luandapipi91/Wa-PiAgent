import type { View } from "../App";
import { SYSTEM_PROJECT_ID } from "@hiagent/shared";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";
import { ProjectItem } from "./ProjectItem";
import { SettingsButton } from "./SettingsButton";
import { useSettingsStore } from "../store/settings";
import { useProjectsStore } from "../store/projects";

interface Props {
  onNewSession: () => void;
  onChatWith: (name: string) => void;
  onEdit: (name: string) => void;
  onMore: () => void;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  currentView?: View;
}

export function Sidebar(props: Props) {
  // 读取 projects store 的相关字段，用于派生系统项目并传递给 ProjectItem
  const allProjects = useProjectsStore(s => s.projects);
  const sessions = useProjectsStore(s => s.sessions);
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  const currentProjectId = useProjectsStore(s => s.currentProjectId);
  // 默认工作区虚拟项目（系统项目）单独渲染在"默认"独立区
  const systemProject = allProjects.find(p => p.id === SYSTEM_PROJECT_ID);

  return (
    <aside
      className="flex flex-col gap-1.5 p-3.5 overflow-hidden border-r border-hairline"
      style={{ width: 264, background: "var(--surface-elevated)" }}
      data-testid="sidebar"
    >
      <div className="flex items-center gap-2 px-2 pb-2.5">
        <img src="/logo.svg" alt="HiAgent" className="w-7 h-7" style={{ borderRadius: 7 }} />
        <span className="font-extrabold text-[17px] tracking-tight text-primary">HiAgent</span>
      </div>
      <NewSessionButton onNewSession={props.onNewSession} />
      <AgentListSection onChatWith={props.onChatWith} onEdit={props.onEdit} onMore={props.onMore} />

      {/* 默认工作区独立区：仅当存在系统项目时渲染。
          不加小标题、不抢占高度（无 flex-1 / overflow），让该区域按内容自适应。 */}
      {systemProject && (
        <div className="border-t border-hairline mt-2">
          <ProjectItem
            project={systemProject}
            sessions={sessions}
            currentSessionId={currentSessionId}
            selected={systemProject.id === currentProjectId}
            isNewSessionView={props.currentView === "new-session"}
            onSelectSession={props.onSelectSession}
            onNewSessionInProject={props.onNewSessionInProject}
            onSelectProject={props.onSelectProject}
          />
        </div>
      )}

      <ProjectList
        onSelectSession={props.onSelectSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onSelectProject={props.onSelectProject}
        onNewProject={props.onNewProject}
        currentView={props.currentView}
      />
      <SettingsButton onClick={() => useSettingsStore.getState().open()} />
    </aside>
  );
}
