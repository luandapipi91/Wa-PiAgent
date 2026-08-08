import { useEffect, useState } from "react";
import type { AgentName } from "@wa-pi/shared";
import { useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { api } from "../api-client";
import { onMessage } from "../events";
import { Modal } from "./ui/Modal";
import { AgentDropdown } from "./ui/AgentDropdown";
import { useTranslation } from "../i18n/useTranslation";

interface Props { sessionId: string; }

export function AgentSwitcher({ sessionId }: Props) {
  const session = useProjectsStore(s => s.sessions.find(x => x.id === sessionId));
  const agents = useAgentsStore(s => s.list);
  const { t } = useTranslation();
  // 待确认切换目标：非 null 时显示缓存失效确认框
  const [pending, setPending] = useState<AgentName | null>(null);

  // 监听 kernel 广播 session:updated：更新会话主智能体，并向消息流追加本地分隔行
  // （CustomMessage 仅前端展示，不写入 jsonl；content 在构造时插值，避免存入模板占位符）
  useEffect(() => {
    return onMessage(e => {
      if (e.type !== "session:updated" || e.sessionId !== sessionId) return;
      const agentName = e.primaryAgent;
      useProjectsStore.setState(s => ({
        sessions: s.sessions.map(x => x.id === sessionId ? { ...x, primaryAgent: agentName } : x),
      }));
      useSessionStore.getState().append(sessionId, {
        message: { type: "custom", customType: "agent_switch", content: t("agentSwitcher.switchedMessage", { agent: agentName }), timestamp: Date.now() } as any,
      });
    });
  }, [sessionId, t]);

  if (!session) return null;

  const current = agents.find(a => a.displayName === session.primaryAgent);
  const missing = !current;

  // AgentDropdown 选中非当前项后弹出确认框；确认后才发 WS 切换（缓存失效语义）
  const handlePick = (name: AgentName) => setPending(name);
  const handleConfirm = () => {
    if (pending) void api.post(`/api/sessions/${encodeURIComponent(sessionId)}/set-agent`, { agentName: pending });
    setPending(null);
  };
  const handleCancel = () => setPending(null);

  return (
    <div className="relative">
      <AgentDropdown
        agents={agents}
        value={session.primaryAgent}
        onPick={handlePick}
        missing={missing}
        pillTestId="agent-switcher"
        itemTestIdPrefix="switcher"
      />

      {/* 缓存失效确认框（样式参照 ui/ConfirmDialog） */}
      {pending && (
        <Modal onClose={handleCancel} width={400} data-testid="switcher-confirm">
          <div className="p-4 border-b border-hairline">
            <div className="text-primary font-bold text-sm">{t("agentSwitcher.confirmTitle")}</div>
          </div>
          <div className="p-4 text-sm text-secondary leading-relaxed">{t("agentSwitcher.confirmMessage")}</div>
          <div className="flex justify-end gap-2 p-3 border-t border-hairline">
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
              data-testid="switcher-confirm-cancel"
            >{t("common.cancel")}</button>
            <button
              onClick={handleConfirm}
              className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              data-testid="switcher-confirm-ok"
            >{t("agentSwitcher.confirmAction")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
