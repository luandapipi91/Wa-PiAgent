import { useState } from "react";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { SessionRow } from "./SessionRow";

interface Props {
  project: ProjectEntity;
  sessions: SessionEntity[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
}

export function ProjectItem(props: Props) {
  const [expanded, setExpanded] = useState(true);
  const { project, sessions, currentSessionId } = props;
  const mySessions = sessions.filter(s => s.projectId === project.id);
  return (
    <div data-testid={`project-${project.id}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setExpanded(e => !e)} className="text-overlay w-4">
          {expanded ? "▼" : "▶"}
        </button>
        <span className="text-sm text-text flex-1 truncate">{project.name}</span>
        <button
          onClick={() => props.onNewSessionInProject(project.id)}
          className="text-overlay hover:text-blue px-1"
          data-testid={`new-in-${project.id}`}
        >＋</button>
        <button
          onClick={() => props.onProjectSettings(project.id)}
          className="text-overlay hover:text-blue px-1"
        >⚙️</button>
      </div>
      {expanded && mySessions.map(s => (
        <SessionRow
          key={s.id}
          session={s}
          selected={s.id === currentSessionId}
          onSelect={props.onSelectSession}
        />
      ))}
    </div>
  );
}
