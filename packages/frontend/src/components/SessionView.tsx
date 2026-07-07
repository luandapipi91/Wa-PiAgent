import { useEffect } from "react";
import { useProjectsStore } from "../store/projects";
import { useIntercomStore } from "../store/intercom";
import { useAgentsStore } from "../store/agents";
import { useSessionStore } from "../store/session";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskCard } from "./AskCard";
import { agentEmoji } from "../theme/agents";
import { onMessage, send } from "../ws-instance";

// 稳定的空数组引用：避免 session 不存在时 `?? []` 每次返回新引用，
// 触发 React 19 useSyncExternalStore 的「snapshot 不稳定」infinite loop。
const EMPTY_ASKS: never[] = [];

interface Props { sessionId: string; onSwitchToCanvas: () => void; }

export function SessionView({ sessionId, onSwitchToCanvas }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const project = useProjectsStore(s => s.projects.find(p => p.id === session?.projectId));
  const asks = useIntercomStore(s => s.asksBySession[sessionId] ?? EMPTY_ASKS);
  const getGlobalState = useAgentsStore(s => s.getGlobalState);

  useEffect(() => {
    // 请求历史会话消息（切到历史会话时加载持久化内容）
    send({ type: "session:messages", sessionId });
    const off = onMessage(e => {
      if (e.type === "session:messages" && e.sessionId === sessionId) {
        // 批量填充历史消息（覆盖，非追加——避免重复）
        useSessionStore.getState().setMessages(sessionId, e.messages);
      }
      if (e.type === "agent:message" && e.sessionId === sessionId) useSessionStore.getState().append(e.message);
      if (e.type === "intercom:ask" && e.sessionId === sessionId) useIntercomStore.getState().addAsk(e.ask);
      if (e.type === "intercom:reply" && e.sessionId === sessionId) useIntercomStore.getState().resolveAsk(sessionId, e.askMessageId);
      if (e.type === "agent:state") useAgentsStore.getState().setState(`${e.projectId}:${e.agentName}`, e.state);
    });
    return off;
  }, [sessionId]);

  if (!session) return null;
  const activeAsk = asks.find(a => !a.resolved);
  const state = getGlobalState(session.primaryAgent);

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      <header className="flex items-center gap-2 px-4 py-2 border-b border-surface2" style={{ background: "#181825" }}>
        <span className="text-xl">{agentEmoji(session.primaryAgent)}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-text font-semibold">{session.title}</span>
            {activeAsk && (
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: "rgba(250,179,135,0.2)", color: "#fab387" }}
                data-testid="intercom-badge"
              >● {activeAsk.from}→{activeAsk.to} · ask · {Math.floor((Date.now() - activeAsk.startedAt)/1000)}s</span>
            )}
          </div>
          <div className="text-xs text-overlay">{session.primaryAgent} · {project?.cwd ?? ""} · {state}</div>
        </div>
        <button onClick={onSwitchToCanvas} className="text-sm text-subtext hover:text-text">编排画布</button>
      </header>
      <MessageList sessionId={sessionId} />
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <Composer sessionId={sessionId} agentName={session.primaryAgent} />
    </div>
  );
}
