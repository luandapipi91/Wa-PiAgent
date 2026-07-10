import { useEffect, useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { Sidebar } from "./components/Sidebar";
import { NewSessionPane } from "./components/NewSessionPane";
import { SessionView } from "./components/SessionView";
import { EmptyState } from "./components/EmptyState";
import { AgentConfig } from "./components/AgentConfig";
import { Canvas } from "./components/canvas/Canvas";
import { DirTreePicker } from "./components/DirTreePicker";
import { SettingsModal } from "./components/SettingsModal";
import { useSettingsStore } from "./store/settings";
import { useProvidersStore } from "./store/providers";
import { useProjectsStore } from "./store/projects";
import { useSessionStore } from "./store/session";
import { useSkillsStore } from "./store/skills";
import { useToastStore } from "./store/toast";
import { onMessage, getWs } from "./ws-instance";
import { ToastContainer } from "./components/ui/Toast";

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
    useProvidersStore.getState().load();
    useSkillsStore.getState().load();
    const off = onMessage(e => {
      const ps = useProjectsStore.getState();  // 每次事件取最新，避免 stale
      switch (e.type) {
        case "projects:list": ps.setAll(e.projects, e.sessions); break;
        case "project:created": ps.addProject(e.project); break;
        case "session:created": ps.addSession(e.session); break;
        // sdk:event：所有 SDK 流式事件统一走 store.handleSDKEvent 分发
        // （message_start/update/end、agent_start/end 等由 store 管理两态）
        case "sdk:event": useSessionStore.getState().handleSDKEvent(e.sessionId, e); break;
        case "error": {
          // kernel/pi 错误：注入当前会话作为系统错误消息（红色显示）
          const sid = useProjectsStore.getState().currentSessionId;
          if (sid) {
            // 构造 SessionMessage（新 append 签名：sessionId + SessionMessage）
            // error 不属于具体 agent，agentName 用任意合法默认；stopReason 标 "error" 供渲染层识别
            useSessionStore.getState().append(sid, {
              message: {
                role: "assistant",
                content: [{ type: "text", text: `⚠️ ${e.message}` }],
                model: "system",
                stopReason: "error",
                timestamp: Date.now(),
              },
              agentName: e.agentName ?? "dev",
              sessionId: sid,
            });
          } else {
            useToastStore.getState().add(e.message);
          }
          break;
        }
        case "provider:list": useProvidersStore.getState().setProviders(e.providers); break;
        case "provider:changed": useProvidersStore.getState().setProviders(e.providers); break;
        case "skill:list": useSkillsStore.getState().setAll(e); break;
        case "skill:changed": useSkillsStore.getState().setAll(e); break;
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
    <div className="flex h-screen bg-canvas">
      <Sidebar
        onNewSession={() => setView("new-session")}
        onSelectAgent={(name) => setConfigAgent(name)}
        onSelectSession={(id) => { useProjectsStore.getState().selectSession(id); setView("session"); }}
        onNewSessionInProject={(pid) => { useProjectsStore.getState().selectProject(pid); useProjectsStore.getState().setCurrentSessionId(null); setView("new-session"); }}
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
              className="p-2 text-sm text-secondary hover:text-primary"
            >
              ← 返回会话
            </button>
            <Canvas />
          </div>
        )}
      </main>
      {configAgent && <AgentConfig agentName={configAgent} onClose={() => setConfigAgent(null)} />}
      {useProjectsStore(s => s.dirPickerOpen) && (
        <DirTreePicker
          onPick={(cwd) => useProjectsStore.getState().createProjectFromPath(cwd)}
          onCancel={() => useProjectsStore.getState().closeDirPicker()}
        />
      )}
      {useSettingsStore(s => s.showSettings) && <SettingsModal onClose={() => useSettingsStore.getState().close()} />}
      <ToastContainer />
    </div>
  );
}
