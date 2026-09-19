import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  agentDefOf,
  aggregateAgentState,
  isSubagentType,
  SUBAGENT_TYPES,
} from "@wa-pi/shared";
import type { AgentStatus } from "@wa-pi/shared";
import { api } from "../api-client";
import { useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { selectPendingAsks } from "../store/ask";
import { STATUS_COLORS } from "../theme/colors";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";
import { AgentCreatePicker } from "./onboarding/AgentCreatePicker";

interface Props {
  onClose: () => void;
  onChatWith: (name: string) => void;
  onEdit: (name: string) => void;
  /** 新建成功后回调（乐观打开契约）：同一 WS 连接上 kernel 顺序处理消息，
   *  agent:create 写盘先于随后的 agent:config:get，消费者可立即打开详情弹窗。 */
  onCreated: (name: string) => void;
}

// 右键菜单坐标 + 目标 agent
interface CtxMenuState {
  x: number;
  y: number;
  name: string;
}

export function AgentGalleryModal({
  onClose,
  onChatWith,
  onEdit,
  onCreated,
}: Props) {
  const { t } = useTranslation();
  // 内置 subagent 卡片的 .map(t => ...) 箭头参数遮蔽了 i18n 的 t，提前算好角标文案
  const builtinBadge = t("agentGallery.builtinBadge");
  const agents = useAgentsStore((s) => s.list);
  const sessions = useProjectsStore((s) => s.sessions);
  const statusBySession = useSessionStore((s) => s.statusBySession);
  const messagesBySession = useSessionStore((s) => s.messagesBySession);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  // 渠道引用提示（删除确认用）：deleteFor 置位时异步拉取，count>0 时拼到确认文案
  const [usageHint, setUsageHint] = useState("");
  // creating 语义：新建面板（AgentCreatePicker）是否打开
  const [creating, setCreating] = useState(false);

  // 删除二次确认前拉取渠道引用计数：deleteFor 变化触发，
  // count>0 拼接提示文案；失败或 count=0 显示原文案，不阻塞删除流程。
  useEffect(() => {
    if (!deleteFor) {
      setUsageHint("");
      return;
    }
    let cancelled = false;
    api
      .get(`/api/channels/agent-usage/${encodeURIComponent(deleteFor)}`)
      .then((u: any) => {
        if (cancelled || !u || u.count <= 0) return;
        setUsageHint(
          "\n" +
            t("agentGallery.usageHint", {
              count: u.count,
              names: (u.channelNames ?? []).join("、"),
            }),
        );
      })
      .catch(() => {
        /* 接口失败按原文案，不阻塞删除 */
      });
    return () => {
      cancelled = true;
    };
  }, [deleteFor]);

  // 右键菜单关闭（点击任意处 / ESC），模式同 AgentListSection / ProjectItem
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    // stopPropagation：菜单监听在 document、Modal 的 ESC 监听在 window，
    // 阻止冒泡避免 ESC 同时关掉菜单和弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
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

  // 状态点逻辑同 AgentListSection：名下会话活状态聚合（blocked > thinking > idle）
  const statusOf = (name: string): AgentStatus =>
    aggregateAgentState(
      sessions
        .filter((s) => s.primaryAgent === name)
        .map((s) => ({
          name,
          status:
            selectPendingAsks(messagesBySession[s.id] ?? []).length > 0
              ? ("blocked" as const)
              : (statusBySession[s.id] ?? "idle"),
        })),
    );

  return (
    <Modal onClose={onClose} width={640} data-testid="agent-gallery">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-hairline">
        <div className="text-sm font-bold text-primary">
          {t("agentGallery.titleAllCount", { count: agents.length })}
        </div>
        <button
          onClick={onClose}
          className="text-tertiary text-xs"
          data-testid="agent-gallery-close"
          aria-label={t("common.close")}
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 px-5 py-4 max-h-[440px] overflow-y-auto">
        {agents.map((agent) => {
          const def = agentDefOf(agent.displayName);
          const status = statusOf(agent.displayName);
          // 头像优先 config 的 avatar/avatarColor（"hex-hex" 渐变），缺省回退内置 agentDefOf
          const [c1, c2] = agent.avatarColor?.includes("-")
            ? agent.avatarColor.split("-")
            : def.gradient;
          return (
            <div
              key={agent.displayName}
              onClick={() => onChatWith(agent.displayName)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({
                  x: e.clientX,
                  y: e.clientY,
                  name: agent.displayName,
                });
              }}
              className={`relative rounded-md border px-3.5 py-4 cursor-pointer transition-colors hover:border-hairline-strong ${ctxMenu?.name === agent.displayName ? "border-accent" : "border-hairline"}`}
              data-testid={`gallery-card-${agent.displayName}`}
            >
              <span
                className="absolute top-3 right-3 w-[7px] h-[7px] rounded-full"
                style={{ background: STATUS_COLORS[status] }}
                data-testid={`gallery-status-${agent.displayName}`}
              />
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-xl mb-2.5"
                style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}
              >
                {agent.avatar || def.emoji}
              </div>
              <div className="text-[calc(13px*var(--font-scale))] font-semibold text-primary mb-1 truncate">
                {agent.displayName}
              </div>
              <div className="text-[calc(11px*var(--font-scale))] text-tertiary leading-[1.5] line-clamp-2">
                {agent.description}
              </div>
            </div>
          );
        })}
        {/* 内置 subagent 类型卡片：显示在所有用户智能体之后，不可删除/不可编辑。
            左键 = 查看详情（onEdit 打开只读 AgentConfig），与右键「👁 查看」一致；
            内置 subagent 是被 delegate 调起的子智能体，不作为会话主智能体单独对话，
            故左键不走 onChatWith（原行为会跳到新建页并触发 AgentDropdown 警示态）。 */}
        {SUBAGENT_TYPES.map((t) => (
          <div
            key={t.name}
            onClick={() => onEdit(t.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, name: t.name });
            }}
            className={`relative rounded-md border px-3.5 py-4 cursor-pointer transition-colors hover:border-hairline-strong ${ctxMenu?.name === t.name ? "border-accent" : "border-hairline"}`}
            data-testid={`gallery-card-${t.name}`}
          >
            <span
              className="absolute top-3 left-3 px-1.5 py-0.5 text-[calc(10px*var(--font-scale))] rounded-sm font-normal"
              style={{
                background: "var(--surface-hover)",
                color: "var(--tertiary)",
              }}
              data-testid={`gallery-builtin-badge-${t.name}`}
            >
              {builtinBadge}
            </span>
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center text-xl mb-2.5"
              style={{
                background: `linear-gradient(135deg, ${t.gradient[0]}, ${t.gradient[1]})`,
              }}
            >
              {t.emoji}
            </div>
            <div className="text-[calc(13px*var(--font-scale))] font-semibold text-primary mb-1 truncate">
              {t.displayName}
            </div>
            <div className="text-[calc(11px*var(--font-scale))] text-tertiary leading-[1.5] line-clamp-2">
              {t.description}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between px-5 py-2.5 border-t border-hairline">
        <div className="text-[calc(11px*var(--font-scale))] text-tertiary">
          {t("agentGallery.footerHint")}
        </div>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 rounded-sm text-xs border-0 cursor-pointer"
          style={{ background: "var(--accent)", color: "#fff" }}
          data-testid="gallery-create"
        >
          {t("agentGallery.createAgent")}
        </button>
      </div>

      {/* agent 右键菜单 */}
      {ctxMenu &&
        createPortal(
          <div
            className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
            style={{
              left: ctxMenu.x,
              top: ctxMenu.y,
              background: "var(--surface)",
              boxShadow: "var(--shadow-lg)",
              minWidth: 140,
              width: "max-content",
            }}
            onClick={(e) => e.stopPropagation()}
            data-testid="gallery-context-menu"
          >
            {isSubagentType(ctxMenu.name) ? (
              // 内置 subagent：只允许查看（打开只读 AgentConfig）
              <button
                onClick={() => {
                  setCtxMenu(null);
                  onEdit(ctxMenu.name);
                }}
                className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover inline-flex items-center gap-1.5 whitespace-nowrap"
                data-testid="gallery-ctx-view"
              >
                <Icon name="eye" size={12} />
                {t("agentGallery.ctxView")}
              </button>
            ) : (
              // 普通智能体：编辑 + 删除
              <>
                <button
                  onClick={() => {
                    setCtxMenu(null);
                    onEdit(ctxMenu.name);
                  }}
                  className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover inline-flex items-center gap-1.5 whitespace-nowrap"
                  data-testid="gallery-ctx-edit"
                >
                  <Icon name="edit" size={12} />
                  {t("agentGallery.ctxEdit")}
                </button>
                <button
                  onClick={() => {
                    setCtxMenu(null);
                    setDeleteFor(ctxMenu.name);
                  }}
                  className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft inline-flex items-center gap-1.5 whitespace-nowrap"
                  data-testid="gallery-ctx-delete"
                >
                  <Icon name="trash" size={12} /> {t("common.delete")}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}

      {/* 新建智能体面板：独立弹窗层（与删除确认同层），避免塞在宫格卡片底部被挤出视口。
          创建成功后关闭面板并回调 onCreated（乐观打开契约）。
          宫格场景不调 setDefaultAgent（向导专属），autoFocusTab 默认 preset。 */}
      {creating && (
        <Modal
          onClose={() => setCreating(false)}
          width={720}
          data-testid="agent-create-modal"
        >
          <div className="px-5 py-3.5 border-b border-hairline text-sm font-bold text-primary flex items-center justify-between">
            <span>{t("agentGallery.createAgent")}</span>
            <button
              onClick={() => setCreating(false)}
              className="text-tertiary text-xs"
              data-testid="agent-create-modal-close"
              aria-label={t("common.close")}
            >
              ✕
            </button>
          </div>
          <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
            <AgentCreatePicker
              autoFocusTab="preset"
              onCreated={(name) => {
                setCreating(false);
                onCreated(name);
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        </Modal>
      )}

      {/* 删除二次确认 */}
      {deleteFor && (
        <div data-testid="gallery-delete-confirm">
          <ConfirmDialog
            title={t("agentGallery.deleteTitle")}
            message={t("agentGallery.deleteConfirmMsg", {
              name:
                agents.find((a) => a.displayName === deleteFor)?.displayName ??
                deleteFor,
              usageHint,
            })}
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
    </Modal>
  );
}
