import type { AgentName } from "@hiagent/shared";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";

interface Props {
  onNewSession: () => void;
  onSelectAgent: (name: AgentName) => void;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
}

export function Sidebar(props: Props) {
  return (
    <aside
      className="flex flex-col gap-1 p-2 overflow-hidden"
      style={{ width: 260, background: "#181825" }}
      data-testid="sidebar"
    >
      <NewSessionButton onNewSession={props.onNewSession} />
      <AgentListSection onSelectAgent={props.onSelectAgent} />
      <ProjectList
        onSelectSession={props.onSelectSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onSelectProject={props.onSelectProject}
        onNewProject={props.onNewProject}
      />
    </aside>
  );
}
