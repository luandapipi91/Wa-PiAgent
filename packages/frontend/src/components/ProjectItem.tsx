import { useState } from "react";
import type { ProjectEntity, SessionEntity } from "@hiagent/shared";
import { SessionRow } from "./SessionRow";

interface Props {
  project: ProjectEntity;
  sessions: SessionEntity[];
  currentSessionId: string | null;
  selected: boolean;
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
}

export function ProjectItem(props: Props) {
  const [expanded, setExpanded] = useState(true);
  const { project, sessions, currentSessionId, selected } = props;
  const mySessions = sessions.filter(s => s.projectId === project.id);
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
        />
      ))}
    </div>
  );
}
