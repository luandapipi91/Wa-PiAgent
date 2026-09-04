import { useEffect, useState } from "react";
import type { AgentName } from "@wa-pi/shared";
import { useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { api } from "../api-client";
import { onMessage } from "../events";
import { Modal } from "./ui/Modal";
import { AgentDropdown } from "./ui/AgentDropdown";
import { useToastStore } from "../store/toast";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
    sessionId: string;
    /** 只读模式：仅显示当前角色图标+名字，不提供下拉切换/编辑（会话内固定角色入口） */
    readOnly?: boolean;
}

export function AgentSwitcher({ sessionId, readOnly = false }: Props) {
    const session = useProjectsStore((s) =>
        s.sessions.find((x) => x.id === sessionId),
    );
    const agents = useAgentsStore((s) => s.list);
    const { t } = useTranslation();
    const addToast = useToastStore((s) => s.add);
    // 待确认切换目标：非 null 时显示缓存失效确认框
    const [pending, setPending] = useState<AgentName | null>(null);

    // 监听 kernel 广播 session:updated：更新会话主智能体，并向消息流追加本地分隔行
    // （readOnly 只禁顶部下拉交互；primaryAgent 变化，含缺失恢复重选，仍应提示分隔行）
    useEffect(() => {
        return onMessage((e) => {
            if (e.type !== "session:updated" || e.sessionId !== sessionId)
                return;
            const agentName = e.primaryAgent;
            useProjectsStore.setState((s) => ({
                sessions: s.sessions.map((x) =>
                    x.id === sessionId ? { ...x, primaryAgent: agentName } : x,
                ),
            }));
            useSessionStore.getState().append(sessionId, {
                message: {
                    type: "custom",
                    customType: "agent_switch",
                    content: t("agentSwitcher.switchedMessage", {
                        agent: agentName,
                    }),
                    timestamp: Date.now(),
                } as any,
            });
        });
    }, [sessionId, t]);

    if (!session) return null;

    const current = agents.find((a) => a.displayName === session.primaryAgent);
    const missing = !current;

    // 只读模式仅约束「角色存在时不能随意切换」；角色被删除（missing）属异常态，
    // 必须允许点击重选恢复（否则会话废了），因此只读展示只在角色存在时生效。
    // 只读展示：与状态行统一样式（无边框盒子感，仅 emoji 色块 + 角色名）
    if (readOnly && !missing) {
        return (
            <span
                className="inline-flex min-w-0 items-center gap-1 text-[calc(12px*var(--font-scale))] text-secondary"
                data-testid="agent-switcher"
                title={current.displayName}
            >
                <span
                    className="w-[16px] h-[16px] rounded-sm flex items-center justify-center text-[calc(11px*var(--font-scale))] flex-none"
                    style={{
                        background: current.avatarColor?.includes("-")
                            ? `linear-gradient(135deg, ${current.avatarColor
                                  .split("-")
                                  .map((s) => s.trim())
                                  .join(", ")})`
                            : current.avatarColor || undefined,
                    }}
                >
                    {current.avatar}
                </span>
                <span className="max-w-[180px] truncate">
                    {current.displayName}
                </span>
            </span>
        );
    }

    // 非只读，或角色已删除（missing）：走交互式 AgentDropdown，可点击展开重选
    // （missing 时 pill 呈现警示态，点击可重选恢复）
    const handlePick = (name: AgentName) => setPending(name);
    const handleConfirm = () => {
        if (pending) {
            const name = pending;
            void api
                .post(
                    `/api/sessions/${encodeURIComponent(sessionId)}/set-agent`,
                    { agentName: name },
                )
                .catch(() => {
                    addToast(t("agentSwitcher.switchFailed"), "error");
                });
        }
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
                <Modal
                    onClose={handleCancel}
                    width={400}
                    data-testid="switcher-confirm"
                >
                    <div className="p-4 border-b border-hairline flex items-center justify-between">
                        <div className="text-primary font-bold text-sm">
                            {t("agentSwitcher.confirmTitle")}
                        </div>
                        <button
                            onClick={handleCancel}
                            className="text-tertiary text-xs"
                            data-testid="switcher-confirm-close"
                            aria-label={t("common.close")}
                        >
                            ✕
                        </button>
                    </div>
                    <div className="p-4 text-sm text-secondary leading-relaxed">
                        {t("agentSwitcher.confirmMessage")}
                    </div>
                    <div className="flex justify-end gap-2 p-3 border-t border-hairline">
                        <button
                            onClick={handleCancel}
                            className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
                            data-testid="switcher-confirm-cancel"
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            onClick={handleConfirm}
                            className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
                            style={{
                                background: "var(--brand)",
                                color: "var(--on-brand)",
                            }}
                            data-testid="switcher-confirm-ok"
                        >
                            {t("agentSwitcher.confirmAction")}
                        </button>
                    </div>
                </Modal>
            )}
        </div>
    );
}
