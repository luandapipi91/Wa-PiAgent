import { useEffect, useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { Sidebar } from "./components/Sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { Canvas } from "./components/canvas/Canvas";
import { useProjectsStore } from "./store/projects";
import { useSessionStore } from "./store/session";
import { useAgentsStore } from "./store/agents";
import { useIntercomStore } from "./store/intercom";
import { onMessage, getWs } from "./ws-instance";

type View = "empty" | "new-session" | "session" | "canvas";

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
        case "agent:message": {
          // agent 回复注入当前会话消息流（kernel 已带 sessionId）
          useSessionStore.getState().append(e.message);
          break;
        }
        case "agent:state": {
          // 状态更新（idle/thinking/blocked）
          useAgentsStore.getState().setState(
            `${e.projectId}:${e.agentName}` as import("@hiagent/shared").AgentStateKey,
            e.state,
          );
          break;
        }
        case "intercom:ask": {
          useIntercomStore.getState().addAsk(e.ask);
          break;
        }
        case "intercom:reply": {
          useIntercomStore.getState().resolveAsk(e.sessionId, e.askMessageId);
          break;
        }
        case "error": {
          // kernel/pi 错误：注入当前会话作为系统错误消息（红色显示）
          const sid = useProjectsStore.getState().currentSessionId;
          if (sid) {
            useSessionStore.getState().append({
              id: `err-${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              text: `⚠️ ${e.message}`,
              timestamp: Date.now(),
            });
          } else {
            // 无当前会话时用 alert 提示
            window.alert(e.message);
          }
          break;
        }
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
        onSelectProject={(pid) => { useProjectsStore.getState().selectProject(pid); useProjectsStore.getState().setCurrentSessionId(null); setView("new-session"); }}
        onNewProject={() => { void useProjectsStore.getState().createProjectFromDir(); }}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {view === "empty" && <EmptyState onNewProject={() => { void useProjectsStore.getState().createProjectFromDir(); }} />}
        {view === "new-session" && <NewSessionPane />}
        {view === "session" && currentSessionId && <SessionView sessionId={currentSessionId} onSwitchToCanvas={() => setView("canvas")} />}
        {view === "canvas" && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <button
              onClick={() => setView(currentSessionId ? "session" : "new-session")}
              className="p-2 text-sm text-subtext hover:text-text"
            >
              ← 返回会话
            </button>
            <Canvas />
          </div>
        )}
      </main>
      {configAgent && <AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />}
    </div>
  );
}
