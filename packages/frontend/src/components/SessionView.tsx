import { useEffect, useState } from "react";
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
  const queue = useSessionStore(s => s.queueBySession[sessionId]);
  const status = useSessionStore(s => s.statusBySession[sessionId] ?? "idle");

  // 执行计时器：agent_start 启动，agent_end 停止
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status === "thinking") {
      const start = Date.now() - elapsed * 1000;
      const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
      return () => clearInterval(timer);
    } else {
      setElapsed(0);
    }
  }, [status]);

  useEffect(() => {
    send({ type: "session:messages", sessionId });
    const off = onMessage(e => {
      if (e.type === "session:messages" && e.sessionId === sessionId) {
        useSessionStore.getState().setMessages(sessionId, e.messages);
      }
    });
    return off;
  }, [sessionId]);

  if (!session) return null;
  const agentState = getGlobalState(session.primaryAgent);
  const isRunning = status === "thinking";
  const steering = queue?.steering ?? [];
  const followUp = queue?.followUp ?? [];
  const hasQueue = steering.length > 0 || followUp.length > 0;

  const handleStop = () => send({ type: "agent:abort", projectId: session.projectId, sessionId, agentName: session.primaryAgent });
  const handlePromote = (text: string) => {
    const idx = followUp.indexOf(text);
    const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : followUp;
    send({ type: "steer:promote", sessionId, text, remainingTexts: remaining });
  };
  const handleImmediate = (text: string) => {
    const idx = followUp.indexOf(text);
    const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : followUp;
    send({ type: "steer:immediate", sessionId, text, remainingTexts: remaining });
  };
  const handleCancelSteer = () => send({ type: "steer:cancel", sessionId });
  const handleClearFollowUp = () => send({ type: "steer:clear-queue", sessionId });

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      {/* 顶部状态栏 */}
      <header className="flex items-center gap-2 px-4 py-2 border-b border-surface2" style={{ background: "#181825" }}>
        <span className="text-xl">{agentEmoji(session.primaryAgent)}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-text font-semibold">{session.title}</span>
          </div>
          <div className="text-xs text-overlay">{session.primaryAgent} · {project?.cwd ?? ""} · {agentState}</div>
        </div>
        <button onClick={onSwitchToCanvas} className="text-sm text-subtext hover:text-text">编排画布</button>
      </header>

      {/* 队列面板：agent 运行中或有队列时显示 */}
      {(isRunning || hasQueue) && (
        <div className="px-4 py-2 border-b border-surface2 text-sm" style={{ background: "#11111b" }} data-testid="queue-panel">
          {/* 状态栏：时间 + 停止 */}
          {isRunning && (
            <div className="flex items-center justify-between mb-1">
              <span className="text-overlay">
                🟠 思考中... {elapsed}s
              </span>
              <button onClick={handleStop} className="px-2 py-0.5 rounded text-xs" style={{ background: "#f38ba8", color: "#1e1e2e" }} data-testid="btn-stop">
                停止
              </button>
            </div>
          )}

          {/* 引导中消息 */}
          {steering.length > 0 && (
            <div className="mb-2 p-2 rounded" style={{ background: "#1e1e2e" }}>
              <div className="flex items-center justify-between">
                <span className="text-peach text-xs font-semibold">引导中:</span>
                <button onClick={handleCancelSteer} className="text-xs px-2 py-0.5 rounded" style={{ background: "#313244", color: "#f38ba8" }} data-testid="btn-cancel-steer">
                  取消
                </button>
              </div>
              {steering.map((msg, i) => (
                <div key={i} className="text-text mt-1 pl-2 border-l-2" style={{ borderColor: "#fab387" }}>
                  {msg}
                </div>
              ))}
            </div>
          )}

          {/* 排队消息列表 */}
          {followUp.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-overlay text-xs">
                  排队 {followUp.length} 条
                </span>
                <button onClick={handleClearFollowUp} className="text-xs px-2 py-0.5 rounded" style={{ background: "#313244", color: "#f38ba8" }} data-testid="btn-clear-queue">
                  清空
                </button>
              </div>
              <div className="rounded" style={{ background: "#1e1e2e" }}>
                {followUp.map((msg, i) => (
                  <div key={i} className="flex items-center justify-between px-2 py-1.5" style={{ borderBottom: i < followUp.length - 1 ? "1px solid #313244" : "none" }}>
                    <span className="text-subtext truncate flex-1">{msg}</span>
                    <div className="flex gap-1 ml-2">
                      <button onClick={() => handlePromote(msg)} className="text-xs px-1.5 py-0.5 rounded" style={{ background: "#a6e3a1", color: "#1e1e2e" }} data-testid="btn-promote">
                        引导
                      </button>
                      <button onClick={() => handleImmediate(msg)} className="text-xs px-1.5 py-0.5 rounded" style={{ background: "#89b4fa", color: "#1e1e2e" }} data-testid="btn-immediate">
                        立即
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 空队列：只保留停止/计时器，不显示占位文字 */}

          {/* 提示 */}
          {followUp.length > 0 && (
            <div className="text-overlay text-xs mt-1">💡 引导：下回合立即生效 │ 立即：中断当前并立即执行</div>
          )}
        </div>
      )}

      <MessageList sessionId={sessionId} />
      <Composer sessionId={sessionId} agentName={session.primaryAgent} />
    </div>
  );
}
