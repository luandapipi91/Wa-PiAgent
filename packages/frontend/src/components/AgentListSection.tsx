import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { agentDefOf, aggregateAgentState } from "@wa-pi/shared";
import type { AgentStatus } from "@wa-pi/shared";
import { api } from "../api-client";
import { topAgentsByRecency, useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { selectPendingAsks } from "../store/ask";
import { STATUS_COLORS } from "../theme/colors";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
  onChatWith: (name: string) => void;
  onEdit: (name: string) => void;
  onMore: () => void;
}

// 右键菜单坐标 + 目标 agent
interface CtxMenuState { x: number; y: number; name: string; }

export function AgentListSection({ onChatWith, onEdit, onMore }: Props) {
  const { t } = useTranslation();
  const agents = useAgentsStore(s => s.list);
  const sessions = useProjectsStore(s => s.sessions);
  const statusBySession = useSessionStore(s => s.statusBySession);
  const messagesBySession = useSessionStore(s => s.messagesBySession);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  // 渠道引用提示（删除确认用）：deleteFor 置位时异步拉取，count>0 时拼到确认文案
  const [usageHint, setUsageHint] = useState("");
  // 空态内联新建（模式同 AgentGalleryModal 的新建小表单）
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const top = topAgentsByRecency(agents, sessions, 3);

  // 删除二次确认前拉取渠道引用计数：deleteFor 变化触发，
  // count>0 拼接提示文案；失败或 count=0 显示原文案，不影响删除流程。
  useEffect(() => {
    if (!deleteFor) { setUsageHint(""); return; }
    let cancelled = false;
    api.get(`/api/channels/agent-usage/${encodeURIComponent(deleteFor)}`)
      .then((u: any) => {
        if (cancelled || !u || u.count <= 0) return;
        setUsageHint(
          "\n" + t("agentList.usageHint", { count: u.count, names: (u.channelNames ?? []).join("、") }),
        );
      })
      .catch(() => { /* 接口失败按原文案，不阻塞删除 */ });
    return () => { cancelled = true; };
  }, [deleteFor]);

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    useAgentsStore.getState().createAgent(name);
    setCreating(false);
    setNewName("");
  };

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
    onChatWith(name);
  };

  return (
    <div className="mb-2 mt-1 border-b border-hairline pb-2">
      <div className="text-[calc(11px*var(--font-scale))] font-bold text-tertiary px-2 pb-1 uppercase tracking-wide flex items-center justify-between">
        {t("agentList.sectionTitle")}
        <span className="bg-surface-hover rounded px-1.5 normal-case">{agents.length}</span>
      </div>
      {top.map(agent => {
        const def = agentDefOf(agent.displayName);
        const status = statusOf(agent.displayName);
        // 头像优先 config 的 avatar/avatarColor（"hex-hex" 渐变），缺省回退内置 agentDefOf
        const [c1, c2] = agent.avatarColor?.includes("-") ? agent.avatarColor.split("-") : def.gradient;
        return (
          <button
            key={agent.displayName}
            onClick={() => handleChat(agent.displayName)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, name: agent.displayName }); }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm transition-colors hover:bg-surface-hover text-left"
            data-testid={`agent-${agent.displayName}`}
          >
            <span
              className="w-[26px] h-[26px] rounded-md flex items-center justify-center text-sm flex-shrink-0"
              style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
            >{agent.avatar || def.emoji}</span>
            <span className="text-[calc(13px*var(--font-scale))] text-secondary flex-1 min-w-0 truncate">{agent.displayName}</span>
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: STATUS_COLORS[status] }}
              data-testid={`status-${agent.displayName}`}
            />
          </button>
        );
      })}
      {agents.length > 3 && (
        <button
          onClick={onMore}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-[calc(13px*var(--font-scale))] text-tertiary transition-colors hover:bg-surface-hover hover:text-secondary text-left"
          data-testid="agent-more"
        >{t("agentList.more", { count: agents.length - 3 })}</button>
      )}
      {agents.length === 0 && (creating ? (
        <div className="px-2 py-1">
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") submitCreate();
              else if (e.key === "Escape") { setCreating(false); setNewName(""); }
            }}
            onBlur={() => { setCreating(false); setNewName(""); }}
            placeholder={t("agentList.namePlaceholder")}
            className="w-full px-2 py-1.5 rounded-sm border border-hairline bg-surface text-[calc(13px*var(--font-scale))] text-primary outline-none placeholder:text-tertiary"
            data-testid="agent-empty-input"
          />
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-[calc(13px*var(--font-scale))] text-tertiary transition-colors hover:bg-surface-hover hover:text-secondary text-left"
          data-testid="agent-empty-create"
        >{t("agentList.createAgent")}</button>
      ))}

      {/* agent 右键菜单 */}
      {ctxMenu && createPortal(
        <div
          className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
          style={{
            left: ctxMenu.x, top: ctxMenu.y,
            background: "var(--surface)",
            boxShadow: "var(--shadow-lg)", minWidth: 140, width: "max-content",
          }}
          onClick={e => e.stopPropagation()}
          data-testid="agent-context-menu"
        >
          <button
            onClick={() => { setCtxMenu(null); onEdit?.(ctxMenu.name); }}
            className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover inline-flex items-center gap-1.5 whitespace-nowrap"
            data-testid="agent-ctx-edit"
          ><Icon name="edit" size={12} />{t("agentList.ctxEdit")}</button>
          <button
            onClick={() => { setCtxMenu(null); setDeleteFor(ctxMenu.name); }}
            className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft inline-flex items-center gap-1.5 whitespace-nowrap"
            data-testid="agent-ctx-delete"
          ><Icon name="trash" size={12} /> {t("common.delete")}</button>
        </div>,
        document.body
      )}

      {/* 删除二次确认 */}
      {deleteFor && (
        <div data-testid="agent-delete-confirm">
          <ConfirmDialog
            title={t("agentList.deleteTitle")}
            message={t("agentList.deleteConfirmMsg", { name: agents.find(a => a.displayName === deleteFor)?.displayName ?? deleteFor, usageHint })}
            confirmText={t("common.delete")}
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
