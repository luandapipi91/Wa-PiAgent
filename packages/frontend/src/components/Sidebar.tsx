import type { View } from "../App";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";
import { SettingsButton } from "./SettingsButton";
import { useSettingsStore } from "../store/settings";

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

      {/* 默认工作区已合并到 ProjectList 顶部，与普通项目共用同一滚动容器 */}
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
