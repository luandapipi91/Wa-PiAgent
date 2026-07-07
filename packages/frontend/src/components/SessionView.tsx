import { useEffect } from "react";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore } from "../store/agents";
import { useSessionStore } from "../store/session";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { agentEmoji } from "../theme/agents";
import { onMessage, send } from "../ws-instance";

interface Props { sessionId: string; onSwitchToCanvas: () => void; }

export function SessionView({ sessionId, onSwitchToCanvas }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const project = useProjectsStore(s => s.projects.find(p => p.id === session?.projectId));
  const getGlobalState = useAgentsStore(s => s.getGlobalState);

  useEffect(() => {
    // 请求历史会话消息（切到历史会话时加载持久化内容）
    send({ type: "session:messages", sessionId });
    const off = onMessage(e => {
      if (e.type === "session:messages" && e.sessionId === sessionId) {
        // 批量填充历史消息（覆盖，非追加——避免重复）
        useSessionStore.getState().setMessages(sessionId, e.messages);
      }
      if (e.type === "agent:message" && e.sessionId === sessionId) useSessionStore.getState().append(sessionId, e.message);
      if (e.type === "agent:state") useAgentsStore.getState().setState(`${e.projectId}:${e.agentName}`, e.state);
    });
    return off;
  }, [sessionId]);

  if (!session) return null;
  const state = getGlobalState(session.primaryAgent);

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-surface2" style={{ background: "#181825" }}>
        <span className="text-xl">{agentEmoji(session.primaryAgent)}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-text font-semibold">{session.title}</span>
          </div>
          <div className="text-xs text-overlay">{session.primaryAgent} · {project?.cwd ?? ""} · {state}</div>
        </div>
        <button onClick={onSwitchToCanvas} className="text-sm text-subtext hover:text-text">编排画布</button>
      </header>
      <MessageList sessionId={sessionId} />
      <Composer sessionId={sessionId} agentName={session.primaryAgent} />
    </div>
  );
}
