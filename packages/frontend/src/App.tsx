import { useEffect, useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { Sidebar } from "./components/Sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { useProjectsStore } from "./store/projects";
import { onMessage, getWs } from "./ws-instance";

type View = "empty" | "new-session" | "session";

export function App() {
  // 只订阅渲染所需的最小状态；actions 在回调里用 getState() 取，避免 stale closure
  const projects = useProjectsStore(s => s.projects);
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  const [view, setView] = useState<View>("empty");
  const [configAgent, setConfigAgent] = useState<AgentName | null>(null);

  useEffect(() => {
    getWs();
    useProjectsStore.getState().load();  // getState() 取最新 action
    const off = onMessage(e => {
      const ps = useProjectsStore.getState();  // 每次事件取最新，避免 stale
      switch (e.type) {
        case "projects:list": ps.setAll(e.projects, e.sessions); break;
        case "project:created": ps.addProject(e.project); break;
        case "session:created": ps.addSession(e.session); break;
      }
    });
    return off;
  }, []);  // 空依赖：onMessage 用 getState，不需重订阅

  // 派生 view
  useEffect(() => {
    if (projects.length === 0) setView("empty");
    else if (currentSessionId) setView("session");
    else setView("new-session");
  }, [projects.length, currentSessionId]);

  return (
    <div className="flex h-screen" style={{ background: "#1e1e2e" }}>
      <Sidebar
        onNewSession={() => setView("new-session")}
        onSelectAgent={(name) => setConfigAgent(name)}
        onSelectSession={(id) => { useProjectsStore.getState().selectSession(id); setView("session"); }}
        onNewSessionInProject={(pid) => { useProjectsStore.getState().selectProject(pid); setView("new-session"); }}
        onProjectSettings={() => {}}
        onNewProject={() => { const name = prompt("项目名"); const cwd = prompt("cwd"); if (name && cwd) useProjectsStore.getState().createProject(name, cwd); }}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "empty" && <EmptyState onNewProject={() => useProjectsStore.getState().createProject(prompt("项目名")!, prompt("cwd")!)} />}
        {view === "new-session" && <NewSessionPane />}
        {view === "session" && currentSessionId && <SessionView sessionId={currentSessionId} onSwitchToCanvas={() => {}} />}
      </main>
      {configAgent && <AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />}
    </div>
  );
}
