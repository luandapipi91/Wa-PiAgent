import { useProjectsStore } from "../store/projects";
import { ProjectItem } from "./ProjectItem";

interface Props {
  onSelectSession: (id: string) => void;
  onNewSessionInProject: (projectId: string) => void;
  onProjectSettings: (projectId: string) => void;
  onNewProject: () => void;
}

export function ProjectList(props: Props) {
  const { projects, sessions, currentSessionId } = useProjectsStore();
  return (
    <div className="flex-1 overflow-auto">
      <div className="text-xs text-overlay px-2 py-1 border-t border-surface2 mt-2">项目管理</div>
      {projects.map(p => (
        <ProjectItem
          key={p.id}
          project={p}
          sessions={sessions}
          currentSessionId={currentSessionId}
          {...props}
        />
      ))}
      <button
        onClick={props.onNewProject}
        className="w-full text-left px-2 py-1.5 text-xs text-overlay hover:text-blue"
        data-testid="new-project-btn"
      >＋ 新建项目</button>
    </div>
  );
}
