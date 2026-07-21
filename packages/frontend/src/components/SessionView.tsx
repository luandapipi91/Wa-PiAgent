import { useEffect, useState } from "react";
import { SYSTEM_PROJECT_ID, type AgentStatus } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { useIsBlocked } from "../store/ask";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskDock } from "./ask/AskDock";
import { AgentSwitcher } from "./AgentSwitcher";
import { STATUS_COLORS } from "../theme/colors";
import { onMessage, send } from "../ws-instance";

interface Props { sessionId: string; }

// agent 全局状态的中文文案（header 直接展示给用户，不暴露英文枚举值）
const AGENT_STATE_LABEL: Record<AgentStatus, string> = {
  idle: "空闲",
  thinking: "思考中",
  blocked: "等待回复",
};

export function SessionView({ sessionId }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const project = useProjectsStore(s => s.projects.find(p => p.id === session?.projectId));
  const queue = useSessionStore(s => s.queueBySession[sessionId]);
  const status = useSessionStore(s => s.statusBySession[sessionId] ?? "idle");
  const historyLoading = useSessionStore(s => s.historyLoadingBySession[sessionId] ?? false);
  const isBlocked = useIsBlocked(sessionId);

  // 思考起算时间（按会话独立，切会话不重置/不沿用）。每秒计时交给 <ThinkingTimer> 独立持有，
  // 避免每秒 setElapsed 重渲染整个 SessionView（含 MessageList 的 markdown）造成计时卡顿。
  const thinkingSince = useSessionStore(s => s.thinkingSinceBySession[sessionId] ?? null);

  useEffect(() => {
    // 进入该会话即视为「已读」，清掉会话列表的 new 角标
    useSessionStore.getState().markRead(sessionId);
    // 标记历史加载中：响应到达前置 true，MessageList 在无消息时显示 loading
    useSessionStore.getState().setHistoryLoading(sessionId, true);
    send({ type: "session:messages", sessionId });
    const off = onMessage(e => {
      if (e.type === "session:messages" && e.sessionId === sessionId) {
        useSessionStore.getState().setMessages(sessionId, e.messages);
        useSessionStore.getState().setHistoryLoading(sessionId, false);
      }
    });
    return off;
  }, [sessionId]);

  if (!session) return null;
  const isRunning = status === "thinking";
  // header 状态（圆点颜色与文案共用）：等待回复 blocked > 运行中 thinking > 空闲 idle
  const headerStatus: AgentStatus = isBlocked ? "blocked" : status;
  const steering = queue?.steering ?? [];
  const followUp = queue?.followUp ?? [];
  const hasQueue = steering.length > 0 || followUp.length > 0;

  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  const handleStop = () => {
    console.log(`[SessionView] handleStop sessionId=${sessionId}`);
    setStopping(true);
    send({ type: "agent:abort", projectId: session.projectId, sessionId, agentName: session.primaryAgent });
  };
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
  const handleClearFollowUp = () => {
    // 立即清除本地队列，不等 kernel 回声
    useSessionStore.getState().appendLocalFollowUp(sessionId, ""); // hack to set empty? No.
    // 直接清空 queueBySession
    useSessionStore.setState(s => ({
      queueBySession: { ...s.queueBySession, [sessionId]: { steering: s.queueBySession[sessionId]?.steering ?? [], followUp: [] } },
    }));
    send({ type: "steer:clear-queue", sessionId });
  };

  return (
    <div className="flex-1 flex flex-col h-full" data-testid="session-view">
      {/* 顶部状态栏 */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-hairline bg-surface">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold text-primary">{session.title}</span>
            <AgentSwitcher sessionId={sessionId} />
          </div>
          <div className="text-[11.5px] text-tertiary mt-px">
            <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: STATUS_COLORS[headerStatus] }} data-testid="session-status-dot" />
            {/* 默认工作区会话：不暴露内部工作目录，显示友好文案；普通项目会话仍显示 cwd */}
            {session.projectId === SYSTEM_PROJECT_ID
              ? "默认工作区 · 工作目录"
              : (project?.cwd ?? "")
            } · {AGENT_STATE_LABEL[headerStatus]}
          </div>
        </div>
      </header>

      {/* 队列面板：agent 运行中或有队列时显示 */}
      {(isRunning || hasQueue) && (
        <div className="px-5 py-2.5 border-b border-hairline bg-surface-elevated" data-testid="queue-panel">
          {/* 状态栏：spinner + 计时 + 停止 + 清空 */}
          {(isRunning || followUp.length > 0) && (
            <div className="flex items-center mb-1">
              {isRunning && (
                <span className="flex items-center gap-2 text-[12.5px] text-secondary flex-1">
                  <span className="inline-block w-3.5 h-3.5 rounded-full" style={{ border: "2px solid var(--accent-soft)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
                  思考中 · <ThinkingTimer thinkingSince={thinkingSince} />s
                </span>
              )}
              {!isRunning && <span className="flex-1" />}
              <div className="flex items-center gap-2">
                {isRunning && (
                  <button onClick={handleStop} disabled={historyLoading || stopping} className={`px-2.5 py-0.5 rounded-pill text-[11.5px] font-semibold border-0 ${historyLoading || stopping ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-danger-soft text-danger cursor-pointer"}`} data-testid="btn-stop">
                    {stopping ? "停止中…" : "停止"}
                  </button>
                )}
                {followUp.length > 0 && (
                  <button onClick={handleClearFollowUp} disabled={historyLoading} className={`text-[11.5px] px-2 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-danger-soft text-danger cursor-pointer"}`} data-testid="btn-clear-queue">
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
                      {!isRunning && (
                        <button onClick={() => handleImmediate(msg)} className="text-[11.5px] px-1.5 py-0.5 rounded-pill bg-success-soft text-success border-0 cursor-pointer" data-testid="btn-immediate">
                          立即
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 提示 */}
          {followUp.length > 0 && (
            <div className="text-tertiary text-[11.5px] mt-1">
              {isRunning
                ? "💡 引导：下回合立即生效 │ 停止当前后可点击“立即”"
                : "💡 引导：下回合立即生效 │ 立即：立即执行该消息"}
            </div>
          )}
        </div>
      )}

      <MessageList sessionId={sessionId} />
      <AskDock sessionId={sessionId} />
      <Composer sessionId={sessionId} agentName={session.primaryAgent} isRunning={status === "thinking"} disabled={isBlocked} />
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
