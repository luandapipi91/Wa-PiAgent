import type { AgentName } from "@hiagent/shared";
import type { View } from "../App";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";
import { SettingsButton } from "./SettingsButton";
import { useSettingsStore } from "../store/settings";

interface Props {
  onNewSession: () => void;
  onSelectAgent: (name: AgentName) => void;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  onOpenMemory: () => void;
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
      <AgentListSection onSelectAgent={props.onSelectAgent} />
      <ProjectList
        onSelectSession={props.onSelectSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onSelectProject={props.onSelectProject}
        onNewProject={props.onNewProject}
        currentView={props.currentView}
      />
      <button
        onClick={props.onOpenMemory}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13.5px] text-secondary hover:bg-[var(--surface-hover)]"
        data-testid="sidebar-memory-btn"
      >
        <span>🧠</span>
        <span>记忆</span>
      </button>
      <SettingsButton onClick={() => useSettingsStore.getState().open()} />
    </aside>
  );
}
