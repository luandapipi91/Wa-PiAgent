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

  // 思考起算时间（按会话独立，切会话不重置/不沿用）。每秒计时交给 <ThinkingTimer> 独立持有，
  // 避免每秒 setElapsed 重渲染整个 SessionView（含 MessageList 的 markdown）造成计时卡顿。
  const thinkingSince = useSessionStore(s => s.thinkingSinceBySession[sessionId] ?? null);

  useEffect(() => {
    // 进入该会话即视为「已读」，清掉会话列表的 new 角标
    useSessionStore.getState().markRead(sessionId);
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
    const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : [...followUp];
    send({ type: "steer:promote", sessionId, text, remainingTexts: remaining as string[] });
  };
  const handleImmediate = (text: string) => {
    const idx = followUp.indexOf(text);
    const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : [...followUp];
    send({ type: "steer:immediate", sessionId, text, remainingTexts: remaining as string[] });
  };
  const handleCancelSteer = () => send({ type: "steer:cancel", sessionId });
  const handleClearFollowUp = () => send({ type: "steer:clear-queue", sessionId });

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      {/* 顶部状态栏 */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-hairline bg-surface">
        <span className="text-xl">{agentEmoji(session.primaryAgent)}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold text-primary">{session.title}</span>
          </div>
          <div className="text-[11.5px] text-tertiary mt-px">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1 align-middle" />
            {session.primaryAgent} · {project?.cwd ?? ""} · {agentState}
          </div>
        </div>
        <button onClick={onSwitchToCanvas} className="px-3 py-1.5 text-xs font-semibold rounded-sm border border-hairline bg-surface text-secondary transition-colors hover:border-brand hover:text-brand">
          编排画布
        </button>
      </header>

      {/* 队列面板：agent 运行中或有队列时显示 */}
      {(isRunning || hasQueue) && (
        <div className="px-5 py-2.5 border-b border-hairline bg-surface-elevated" data-testid="queue-panel">
          {/* 状态栏：spinner + 计时 + 停止 + 清空 */}
          {isRunning && (
            <div className="flex items-center mb-1">
              <span className="flex items-center gap-2 text-[12.5px] text-secondary flex-1">
                <span className="inline-block w-3.5 h-3.5 rounded-full" style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
                思考中 · <ThinkingTimer thinkingSince={thinkingSince} />s
              </span>
              <div className="flex items-center gap-2">
                <button onClick={handleStop} className="px-2.5 py-0.5 rounded-pill text-[11.5px] font-semibold bg-danger-soft text-danger border-0 cursor-pointer" data-testid="btn-stop">
                  停止
                </button>
                {followUp.length > 0 && (
                  <button onClick={handleClearFollowUp} className="text-[11.5px] px-2 py-0.5 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer" data-testid="btn-clear-queue">
                    清空
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 引导中消息 */}
          {steering.length > 0 && (
            <div className="mt-2 p-2.5 rounded-sm bg-warning-soft" style={{ borderLeft: "3px solid var(--warning)" }}>
              <div className="flex items-center justify-between">
                <span className="text-warning text-[11.5px] font-bold">引导中</span>
                <button onClick={handleCancelSteer} className="text-[11.5px] px-2 py-0.5 rounded-pill bg-danger-soft text-danger border-0 cursor-pointer" data-testid="btn-cancel-steer">
                  取消
                </button>
              </div>
              {steering.map((msg, i) => (
                <div key={i} className="text-[12px] text-secondary mt-1 pl-2">
                  {msg}
                </div>
              ))}
            </div>
          )}

          {/* 排队消息列表 */}
          {followUp.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-tertiary text-[11.5px]">
                  排队 {followUp.length} 条
                </span>
              </div>
              <div className="rounded-sm bg-surface border border-hairline">
                {followUp.map((msg, i) => (
                  <div key={i} className={`flex items-center justify-between px-2.5 py-1.5 ${i < followUp.length - 1 ? "border-b border-hairline" : ""}`}>
                    <span className="text-secondary truncate flex-1 text-[12.5px]">{msg}</span>
                    <div className="flex ml-2 gap-2">
                      <button onClick={() => handlePromote(msg)} className="text-[11.5px] px-1.5 py-0.5 rounded-pill bg-accent-soft text-accent border-0 cursor-pointer" data-testid="btn-promote">
                        引导
                      </button>
                      <button onClick={() => handleImmediate(msg)} className="text-[11.5px] px-1.5 py-0.5 rounded-pill bg-success-soft text-success border-0 cursor-pointer" data-testid="btn-immediate">
                        立即
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 提示 */}
          {followUp.length > 0 && (
            <div className="text-tertiary text-[11.5px] mt-1">💡 引导：下回合立即生效 │ 立即：中断当前并立即执行</div>
          )}
        </div>
      )}

      <MessageList sessionId={sessionId} />
      <Composer sessionId={sessionId} agentName={session.primaryAgent} isRunning={status === "thinking"} />
    </div>
  );
}

/**
 * 独立的思考计时器：把「每秒 setElapsed」的重渲染隔离在本组件内，
 * 不向上冒泡到 SessionView（进而避免连带重渲染 MessageList 的 markdown）造成计时卡顿。
 * elapsed 始终按真实时间 thinkingSince 推算，切会话/重渲染均准确。
 */
function ThinkingTimer({ thinkingSince }: { thinkingSince: number | null }) {
  const [elapsed, setElapsed] = useState(() => thinkingSince == null ? 0 : Math.floor((Date.now() - thinkingSince) / 1000));
  useEffect(() => {
    if (thinkingSince == null) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor((Date.now() - thinkingSince) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [thinkingSince]);
  return <>{elapsed}</>;
}
