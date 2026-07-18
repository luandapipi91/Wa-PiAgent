import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { agentDefOf, aggregateAgentState } from "@hiagent/shared";
import type { AgentName, AgentStatus } from "@hiagent/shared";
import { topAgentsByRecency, useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { selectPendingAsks } from "../store/ask";
import { STATUS_COLORS } from "../theme/colors";
import { ConfirmDialog } from "./ui/ConfirmDialog";

interface Props {
  onChatWith?: (name: string) => void;
  onEdit?: (name: string) => void;
  onMore?: () => void;
  /** @deprecated 兼容旧接线（Task 16 改为 onChatWith/onEdit 后移除）：未传 onChatWith 时左键回退 */
  onSelectAgent?: (name: AgentName) => void;
}

// 右键菜单坐标 + 目标 agent
interface CtxMenuState { x: number; y: number; name: string; }

export function AgentListSection({ onChatWith, onEdit, onMore, onSelectAgent }: Props) {
  const agents = useAgentsStore(s => s.list);
  const sessions = useProjectsStore(s => s.sessions);
  const statusBySession = useSessionStore(s => s.statusBySession);
  const messagesBySession = useSessionStore(s => s.messagesBySession);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);

  const top = topAgentsByRecency(agents, sessions, 3);

  // 右键菜单关闭（点击任意处 / ESC），模式同 ProjectItem
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const id = setTimeout(() => {
      document.addEventListener("click", close);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // agent 状态点 = 名下所有会话的活状态聚合（kernel 无 agent 级状态推送，从会话级派生）：
  // 任一会话有待回答提问 → blocked；否则任一会话运行中 → thinking；否则 idle
  const statusOf = (name: string): AgentStatus =>
    aggregateAgentState(
      sessions
        .filter(s => s.primaryAgent === name)
        .map(s => ({
          name,
          status: selectPendingAsks(messagesBySession[s.id] ?? []).length > 0
            ? ("blocked" as const)
            : (statusBySession[s.id] ?? "idle"),
        }))
    );

  const handleChat = (name: string) => {
    if (onChatWith) onChatWith(name);
    else onSelectAgent?.(name);
  };

  return (
    <div className="mb-2 mt-1">
      <div className="text-[11px] font-bold text-tertiary px-2 pb-1 uppercase tracking-wide flex items-center justify-between">
        智能体
        <span className="bg-surface-hover rounded px-1.5 normal-case">{agents.length}</span>
      </div>
      {top.map(agent => {
        const def = agentDefOf(agent.name);
        const status = statusOf(agent.name);
        // 头像优先 config 的 avatar/avatarColor（"hex-hex" 渐变），缺省回退内置 agentDefOf
        const [c1, c2] = agent.avatarColor?.includes("-") ? agent.avatarColor.split("-") : def.gradient;
        return (
          <button
            key={agent.name}
            onClick={() => handleChat(agent.name)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, name: agent.name }); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors hover:bg-surface-hover text-left"
            data-testid={`agent-${agent.name}`}
          >
            <span
              className="w-[26px] h-[26px] rounded-md flex items-center justify-center text-sm flex-shrink-0"
              style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
            >{agent.avatar || def.emoji}</span>
            <span className="text-[13px] text-secondary flex-1 min-w-0 truncate">{agent.displayName || def.label}</span>
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: STATUS_COLORS[status] }}
              data-testid={`status-${agent.name}`}
            />
          </button>
        );
      })}
      {agents.length > 3 && (
        <button
          onClick={onMore}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-[13px] text-tertiary transition-colors hover:bg-surface-hover hover:text-secondary text-left"
          data-testid="agent-more"
        >⋯ 更多智能体 ({agents.length - 3})</button>
      )}

      {/* agent 右键菜单 */}
      {ctxMenu && createPortal(
        <div
          className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
          style={{
            left: ctxMenu.x, top: ctxMenu.y,
            background: "var(--surface)",
            boxShadow: "var(--shadow-lg)", minWidth: 140,
          }}
          onClick={e => e.stopPropagation()}
          data-testid="agent-context-menu"
        >
          <button
            onClick={() => { setCtxMenu(null); onEdit?.(ctxMenu.name); }}
            className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
            data-testid="agent-ctx-edit"
          >✏️ 编辑智能体</button>
          <button
            onClick={() => { setCtxMenu(null); setDeleteFor(ctxMenu.name); }}
            className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
            data-testid="agent-ctx-delete"
          >🗑 删除</button>
        </div>,
        document.body
      )}

      {/* 删除二次确认 */}
      {deleteFor && (
        <div data-testid="agent-delete-confirm">
          <ConfirmDialog
            title="删除智能体"
            message={`确定删除智能体「${agents.find(a => a.name === deleteFor)?.displayName ?? deleteFor}」吗？此操作不可撤销。`}
            confirmText="删除"
            danger
            onConfirm={() => {
              useAgentsStore.getState().deleteAgent(deleteFor);
              setDeleteFor(null);
            }}
            onCancel={() => setDeleteFor(null)}
          />
        </div>
      )}
    </div>
  );
}
