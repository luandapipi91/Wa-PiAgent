import { useEffect, useMemo, useState } from "react";
import { SYSTEM_PROJECT_ID, resolveSessionCwd, resolveProviderSlug, type AgentStatus } from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { useIsBlocked } from "../store/ask";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useProvidersStore } from "../store/providers";
import { useExplorerStore } from "../store/explorer";
import { SidebarResizer } from "./SidebarResizer";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { AskDock } from "./ask/AskDock";
import { AgentSwitcher } from "./AgentSwitcher";
import { ExplorerPanel } from "./ExplorerPanel";
import { STATUS_COLORS } from "../theme/colors";
import { api } from "../api-client";

interface Props { sessionId: string; }

// agent 全局状态的中文文案（header 直接展示给用户，不暴露英文枚举值）
const AGENT_STATE_LABEL: Record<AgentStatus, string> = {
  idle: "空闲",
  thinking: "思考中",
  blocked: "等待回复",
};

/** token 数字格式化：&lt;1000 原值，≥1000 用 K，≥1M 用 M，无小数省略 */
function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return v % 1 === 0 ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return v % 1 === 0 ? `${v}K` : `${v.toFixed(1)}K`;
  }
  return String(n);
}

export function SessionView({ sessionId }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const project = useProjectsStore(s => s.projects.find(p => p.id === session?.projectId));
  const queue = useSessionStore(s => s.queueBySession[sessionId]);
  const status = useSessionStore(s => s.statusBySession[sessionId] ?? "idle");
  const historyLoading = useSessionStore(s => s.historyLoadingBySession[sessionId] ?? false);
  const isBlocked = useIsBlocked(sessionId);
  const reloading = useSessionStore(s => s.reloading);
  const messages = useSessionStore(s => s.messagesBySession[sessionId]);
  const isNewSession = !messages || messages.length === 0;

  // 思考起算时间（按会话独立，切会话不重置/不沿用）。每秒计时交给 <ThinkingTimer> 独立持有，
  // 避免每秒 setElapsed 重渲染整个 SessionView（含 MessageList 的 markdown）造成计时卡顿。
  const thinkingSince = useSessionStore(s => s.thinkingSinceBySession[sessionId] ?? null);
  // Token 计数
  const tokenTotal = useSessionStore(s => s.tokenTotals[sessionId]);
  const lastUsage = useSessionStore(s => s.lastUsageBySession[sessionId]);
  // 当前会话所选模型的上下文窗口（用于计算 token 占比）
  const model = useComposerPrefsStore(s => s.bySession[sessionId]?.model ?? null);
  const providers = useProvidersStore(s => s.providers);
  const contextWindow = useMemo(() => {
    if (!model) return null;
    const [slug, ...rest] = model.split("/");
    const modelId = rest.join("/");
    const slugs: string[] = [];
    for (const p of providers) {
      const pSlug = resolveProviderSlug(p, slugs);
      slugs.push(pSlug);
      if (pSlug === slug) {
        const found = p.models.find(m => m.id === modelId);
        return found?.contextWindow ?? null;
      }
    }
    return null;
  }, [model, providers]);

  useEffect(() => {
    // 进入该会话即视为「已读」，清掉会话列表的 new 角标
    useSessionStore.getState().markRead(sessionId);
    // 标记历史加载中：响应到达前置 true，MessageList 在无消息时显示 loading
    useSessionStore.getState().setHistoryLoading(sessionId, true);
    void (async () => {
      try {
        const res = (await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)) as { messages: any[]; isActive: boolean; thinkingSince: number | null };
        useSessionStore.getState().setMessages(sessionId, res.messages);
        useSessionStore.getState().seedTokenTotal(sessionId, res.messages);
        useSessionStore.getState().setActiveStatus(sessionId, res.isActive, res.thinkingSince);
      } finally {
        useSessionStore.getState().setHistoryLoading(sessionId, false);
      }
    })();
  }, [sessionId]);

  // 下面的 hooks 必须在 early return 之前调用，否则 session 在/不在两次渲染
  // 调用的 hooks 数量不一致，触发 "Rendered fewer hooks than expected"。
  const isRunning = status === "thinking";
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  if (!session) return null;
  // header 状态（圆点颜色与文案共用）：等待回复 blocked > 运行中 thinking > 空闲 idle
  const headerStatus: AgentStatus = isBlocked ? "blocked" : status;
  const steering = queue?.steering ?? [];
  const followUp = queue?.followUp ?? [];
  const hasQueue = steering.length > 0 || followUp.length > 0;

  const handleStop = () => {
    console.log(`[SessionView] handleStop sessionId=${sessionId}`);
    setStopping(true);
    void api.post(`/api/agents/${encodeURIComponent(session.projectId)}/${encodeURIComponent(sessionId)}/abort`, { agentName: session.primaryAgent });
  };
  // 乐观更新：立即移动消息位置（去重防止与 kernel queue_update 叠加），后台发 API
  const handlePromote = (text: string) => {
    const idx = followUp.indexOf(text);
    const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : [...followUp];
    useSessionStore.setState(s => {
      const cur = s.queueBySession[sessionId]?.steering ?? [];
      return {
        queueBySession: { ...s.queueBySession, [sessionId]: { steering: cur.includes(text) ? cur : [...cur, text], followUp: remaining } },
      };
    });
    void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, { text });
  };
  const handleImmediate = (text: string) => {
    const idx = followUp.indexOf(text);
    const remaining = idx >= 0 ? [...followUp.slice(0, idx), ...followUp.slice(idx + 1)] : [...followUp];
    useSessionStore.setState(s => {
      const cur = s.queueBySession[sessionId]?.steering ?? [];
      return {
        queueBySession: { ...s.queueBySession, [sessionId]: { steering: cur.includes(text) ? cur : [...cur, text], followUp: remaining } },
      };
    });
    void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/steer/immediate`, { text });
  };
  const handleClearFollowUp = () => {
    useSessionStore.setState(s => ({
      queueBySession: { ...s.queueBySession, [sessionId]: { steering: s.queueBySession[sessionId]?.steering ?? [], followUp: [] } },
    }));
    void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/clear-queue`, {});
  };

  // 右侧文件树面板：开关状态 + 宽度来自 explorer store
  const explorerOpen = useExplorerStore(s => s.open);
  const explorerWidth = useExplorerStore(s => s.width);
  // 文件树根目录：普通项目用 project.cwd，默认工作区会话用其专属临时目录 workdir/<createdAt>/
  const workspaceDir = resolveSessionCwd(session, { cwd: project?.cwd ?? "" });

  return (
    <div className="flex-1 flex h-full" data-testid="session-view">
    {/* 左侧主区：对话内容 */}
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
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
        {/* Token 胶囊标签组 */}
        {lastUsage && (
          <div className="flex items-center gap-2" data-testid="token-capsules">
            <span className="token-capsule">
              本轮: ↑{fmtTok(lastUsage.input)}/↓{fmtTok(lastUsage.output)}
            </span>
            {tokenTotal && (
              <span className="token-capsule token-capsule--stack">
                累计 {fmtTok(tokenTotal.input + tokenTotal.output)}
                {contextWindow && contextWindow > 0 && (() => {
                  const total = tokenTotal.input + tokenTotal.output;
                  const pct = Math.min(total / contextWindow * 100, 100);
                  const w = Math.max(Math.round(pct), 2);
                  return (
                    <span className="token-progress" data-testid="token-progress">
                      <span className="token-progress-fill" style={{ width: `${w}%` }} />
                    </span>
                  );
                })()}
              </span>
            )}
            {(lastUsage.cacheRead > 0 || lastUsage.cacheWrite > 0) && (() => {
              const rate = lastUsage.cacheRead / (lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite) * 100;
              const danger = rate < 90;
              return (
                <span className={`token-capsule token-capsule--cache${danger ? " token-capsule--cache-danger" : ""}`}>
                  缓存 {Math.round(rate * 10) / 10}%
                </span>
              );
            })()}
          </div>
        )}
        {/* 文件树面板开关按钮 */}
        <button
          type="button"
          className="fv-btn"
          data-testid="btn-explorer"
          data-active={explorerOpen ? "true" : "false"}
          onClick={() => useExplorerStore.getState().toggle()}
          title="项目文件"
          style={explorerOpen ? { borderColor: "var(--accent)", color: "var(--accent)" } : { color: "var(--text-tertiary)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
        </button>
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
                      <button onClick={() => handlePromote(msg)} disabled={historyLoading} className={`text-[11.5px] px-1.5 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-accent-soft text-accent cursor-pointer"}`} data-testid="btn-promote">
                        引导
                      </button>
                      {!isRunning && (
                        <button onClick={() => handleImmediate(msg)} disabled={historyLoading} className={`text-[11.5px] px-1.5 py-0.5 rounded-pill border-0 ${historyLoading ? "bg-surface-elevated text-tertiary cursor-not-allowed" : "bg-success-soft text-success cursor-pointer"}`} data-testid="btn-immediate">
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
      <Composer sessionId={sessionId} agentName={session.primaryAgent} isRunning={status === "thinking"} isNewSession={!messages || messages.length === 0} disabled={isBlocked || reloading} />
    </div>
    {/* 右侧文件树面板：开关由 explorer store 控制；双击文件弹窗预览 */}
    {explorerOpen && (
      <>
        <SidebarResizer side="right" onResize={(w) => useExplorerStore.getState().setWidth(w)} testId="explorer-resizer" />
        <aside className="flex flex-col border-l border-hairline bg-surface" style={{ width: explorerWidth, flexShrink: 0 }} data-testid="explorer-aside">
        <div className="flex items-center gap-1 px-3 py-2 border-b border-hairline">
          <span className="text-[12px] font-semibold text-primary flex-1">项目文件</span>
          <button className="fv-btn" onClick={() => useExplorerStore.getState().toggle()} title="收起面板">›</button>
        </div>
        {/* 文件树占满面板，双击文件触发弹窗预览 */}
        <div className="flex-1 overflow-auto">
          <ExplorerPanel workspaceDir={workspaceDir} onOpenFile={(path) => useSessionStore.getState().openFilePreview(path, sessionId)} />
        </div>
      </aside>
      </>
    )}
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
