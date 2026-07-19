import { useEffect, useRef, useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { filterItems } from "../quick-invoke/trigger";
import { onMessage, send } from "../ws-instance";
import { Modal } from "./ui/Modal";

interface Props { sessionId: string; }

// avatarColor 形如 "#06b6d4-#3b82f6"（渐变）或单色；还原为 CSS background
function avatarBackground(color?: string): string | undefined {
  if (!color) return undefined;
  const [c1, c2] = color.split("-").map(s => s.trim());
  return c2 ? `linear-gradient(135deg, ${c1}, ${c2})` : c1;
}

export function AgentSwitcher({ sessionId }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const agents = useAgentsStore(s => s.list);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 待确认切换目标：非 null 时显示缓存失效确认框
  const [pending, setPending] = useState<AgentName | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 监听 kernel 广播 session:updated：更新会话主智能体，并向消息流追加本地分隔行
  // （CustomMessage 仅前端展示，不写入 jsonl）
  useEffect(() => {
    return onMessage(e => {
      if (e.type !== "session:updated" || e.sessionId !== sessionId) return;
      const agentName = e.primaryAgent;
      useProjectsStore.setState(s => ({
        sessions: s.sessions.map(x => x.id === sessionId ? { ...x, primaryAgent: agentName } : x),
      }));
      useSessionStore.getState().append(sessionId, {
        message: { type: "custom", customType: "agent_switch", content: `已切换为 ${agentName}`, timestamp: Date.now() } as any,
      });
    });
  }, [sessionId]);

  // 点击组件外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!session) return null;

  const current = agents.find(a => a.name === session.primaryAgent);
  const missing = !current;
  const filtered = filterItems(agents, query);

  const closeMenu = () => { setOpen(false); setQuery(""); };
  const handlePick = (name: AgentName) => {
    // 选择当前项：不弹确认框直接关闭
    if (name === session.primaryAgent) { closeMenu(); return; }
    setPending(name);
  };
  const handleConfirm = () => {
    if (pending) send({ type: "session:set-agent", sessionId, agentName: pending });
    setPending(null);
    closeMenu();
  };
  const handleCancel = () => setPending(null);

  return (
    <div className="relative" ref={rootRef}>
      {/* 顶部 pill：正常态显示 avatar+displayName+▾；agent 被删时变警示条 */}
      <button
        type="button"
        data-testid="agent-switcher"
        onClick={() => { setOpen(o => !o); setQuery(""); }}
        className={`flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[12px] cursor-pointer transition-colors ${
          missing
            ? "bg-warning-soft text-warning border-warning-soft"
            : "bg-surface-elevated text-secondary border-hairline hover:text-primary"
        }`}
      >
        {missing ? (
          <span data-testid="switcher-missing">⚠️ 原智能体已删除，点击重选 ▾</span>
        ) : (
          <>
            <span
              className="w-[18px] h-[18px] rounded-sm flex items-center justify-center text-[11px] flex-none"
              style={{ background: avatarBackground(current.avatarColor) }}
            >{current.avatar}</span>
            <span>{current.displayName}</span>
            <span style={{ fontSize: 10 }}>▾</span>
          </>
        )}
      </button>

      {/* 展开卡片：搜索框 + 过滤列表 + 当前项 ✓ */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[220px] bg-surface-elevated border border-hairline rounded-md shadow-lg p-1">
          <div className="flex items-center gap-1.5 bg-surface border border-hairline rounded-sm px-2 py-1.5 mx-0.5 mb-1 text-tertiary">
            🔍
            <input
              data-testid="switcher-search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索智能体…"
              className="flex-1 bg-transparent border-0 outline-none text-[12px] text-primary"
            />
          </div>
          {filtered.map(a => (
            <button
              type="button"
              key={a.name}
              data-testid={`switcher-item-${a.name}`}
              onClick={() => handlePick(a.name)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left border-0 transition-colors text-secondary hover:bg-surface-hover ${
                a.name === session.primaryAgent ? "bg-surface-hover" : "bg-transparent"
              }`}
            >
              <span
                className="w-[22px] h-[22px] rounded-sm flex items-center justify-center text-[12px] flex-none"
                style={{ background: avatarBackground(a.avatarColor) }}
              >{a.avatar}</span>
              <span className="min-w-0">
                <div className="text-[12px] text-primary">{a.displayName}</div>
                {a.description && <div className="text-[11px] text-tertiary truncate">{a.description}</div>}
              </span>
              {a.name === session.primaryAgent && <span className="ml-auto text-accent">✓</span>}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-3.5 text-center text-tertiary text-[12px]">无匹配智能体</div>
          )}
        </div>
      )}

      {/* 缓存失效确认框（样式参照 ui/ConfirmDialog） */}
      {pending && (
        <Modal onClose={handleCancel} width={400} data-testid="switcher-confirm">
          <div className="p-4 border-b border-hairline">
            <div className="text-primary font-bold text-sm">切换智能体</div>
          </div>
          <div className="p-4 text-sm text-secondary leading-relaxed">切换智能体后所有缓存都会失效，是否继续？</div>
          <div className="flex justify-end gap-2 p-3 border-t border-hairline">
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
              data-testid="switcher-confirm-cancel"
            >取消</button>
            <button
              onClick={handleConfirm}
              className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              data-testid="switcher-confirm-ok"
            >继续切换</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
