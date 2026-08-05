import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { agentDefOf, aggregateAgentState, isSubagentType, SUBAGENT_TYPES } from "@wa-pi/shared";
import type { AgentStatus } from "@wa-pi/shared";
import { useAgentsStore } from "../store/agents";
import { useProjectsStore } from "../store/projects";
import { useSessionStore } from "../store/session";
import { selectPendingAsks } from "../store/ask";
import { STATUS_COLORS } from "../theme/colors";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Icon } from "./ui/Icon";

interface Props {
  onClose: () => void;
  onChatWith: (name: string) => void;
  onEdit: (name: string) => void;
  /** 新建成功后回调（乐观打开契约）：同一 WS 连接上 kernel 顺序处理消息，
   *  agent:create 写盘先于随后的 agent:config:get，消费者可立即打开详情弹窗。 */
  onCreated: (name: string) => void;
}

// 右键菜单坐标 + 目标 agent
interface CtxMenuState { x: number; y: number; name: string; }

export function AgentGalleryModal({ onClose, onChatWith, onEdit, onCreated }: Props) {
  const agents = useAgentsStore(s => s.list);
  const sessions = useProjectsStore(s => s.sessions);
  const statusBySession = useSessionStore(s => s.statusBySession);
  const messagesBySession = useSessionStore(s => s.messagesBySession);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // 右键菜单关闭（点击任意处 / ESC），模式同 AgentListSection / ProjectItem
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    // stopPropagation：菜单监听在 document、Modal 的 ESC 监听在 window，
    // 阻止冒泡避免 ESC 同时关掉菜单和弹窗
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
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
        .filter(s => s.primaryAgent === name)
        .map(s => ({
          name,
          status: selectPendingAsks(messagesBySession[s.id] ?? []).length > 0
            ? ("blocked" as const)
            : (statusBySession[s.id] ?? "idle"),
        }))
    );

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    useAgentsStore.getState().createAgent(name);
    setCreating(false);
    setNewName("");
    onCreated(name);
  };

  return (
    <Modal onClose={onClose} width={640} data-testid="agent-gallery">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-hairline">
        <div className="text-sm font-bold text-primary">
          全部智能体 <span className="text-xs font-normal text-tertiary ml-1">{agents.length} 个</span>
        </div>
        {creating ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submitCreate(); }}
              placeholder="智能体名称"
              className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none placeholder:text-tertiary"
              data-testid="gallery-create-input"
            />
            <button
              onClick={submitCreate}
              className="px-3 py-1.5 rounded-sm text-xs border-0 cursor-pointer"
              style={{ background: "var(--accent)", color: "#fff" }}
              data-testid="gallery-create-ok"
            >确定</button>
            <button
              onClick={() => { setCreating(false); setNewName(""); }}
              className="px-3 py-1.5 rounded-sm text-xs bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
              data-testid="gallery-create-cancel"
            >取消</button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 rounded-sm text-xs border-0 cursor-pointer"
            style={{ background: "var(--accent)", color: "#fff" }}
            data-testid="gallery-create"
          >＋ 新建智能体</button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 px-5 py-4 max-h-[440px] overflow-y-auto">
        {agents.map(agent => {
          const def = agentDefOf(agent.displayName);
          const status = statusOf(agent.displayName);
          // 头像优先 config 的 avatar/avatarColor（"hex-hex" 渐变），缺省回退内置 agentDefOf
          const [c1, c2] = agent.avatarColor?.includes("-") ? agent.avatarColor.split("-") : def.gradient;
          return (
            <div
              key={agent.displayName}
              onClick={() => onChatWith(agent.displayName)}
              onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, name: agent.displayName }); }}
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
              >{agent.avatar || def.emoji}</div>
              <div className="text-[calc(13px*var(--font-scale))] font-semibold text-primary mb-1 truncate">{agent.displayName}</div>
              <div className="text-[calc(11px*var(--font-scale))] text-tertiary leading-[1.5] line-clamp-2">{agent.description}</div>
            </div>
          );
        })}
        {/* 内置 subagent 类型卡片：显示在所有用户智能体之后，不可删除/不可编辑。
            左键 = 查看详情（onEdit 打开只读 AgentConfig），与右键「👁 查看」一致；
            内置 subagent 是被 delegate 调起的子智能体，不作为会话主智能体单独对话，
            故左键不走 onChatWith（原行为会跳到新建页并触发 AgentDropdown 警示态）。 */}
        {SUBAGENT_TYPES.map(t => (
          <div
            key={t.name}
            onClick={() => onEdit(t.name)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, name: t.name }); }}
            className={`relative rounded-md border px-3.5 py-4 cursor-pointer transition-colors hover:border-hairline-strong ${ctxMenu?.name === t.name ? "border-accent" : "border-hairline"}`}
            data-testid={`gallery-card-${t.name}`}
          >
            <span
              className="absolute top-3 left-3 px-1.5 py-0.5 text-[calc(10px*var(--font-scale))] rounded-sm font-normal"
              style={{ background: "var(--surface-hover)", color: "var(--tertiary)" }}
              data-testid={`gallery-builtin-badge-${t.name}`}
            >内置</span>
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center text-xl mb-2.5"
              style={{ background: `linear-gradient(135deg, ${t.gradient[0]}, ${t.gradient[1]})` }}
            >{t.emoji}</div>
            <div className="text-[calc(13px*var(--font-scale))] font-semibold text-primary mb-1 truncate">{t.displayName}</div>
            <div className="text-[calc(11px*var(--font-scale))] text-tertiary leading-[1.5] line-clamp-2">{t.description}</div>
          </div>
        ))}
      </div>

      <div className="px-5 py-2.5 text-[calc(11px*var(--font-scale))] text-tertiary border-t border-hairline">
        左键：新建会话（内置仅查看）· 右键：编辑 / 删除 · 右上：新建智能体
      </div>

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
          data-testid="gallery-context-menu"
        >
          {isSubagentType(ctxMenu.name) ? (
            // 内置 subagent：只允许查看（打开只读 AgentConfig）
            <button
              onClick={() => { setCtxMenu(null); onEdit(ctxMenu.name); }}
              className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
              data-testid="gallery-ctx-view"
            ><Icon name="eye" size={12} style={{verticalAlign:"-0.125em"}} /> 查看</button>
          ) : (
            // 普通智能体：编辑 + 删除
            <>
              <button
                onClick={() => { setCtxMenu(null); onEdit(ctxMenu.name); }}
                className="w-full text-left px-3 py-1.5 text-primary transition-colors hover:bg-surface-hover"
                data-testid="gallery-ctx-edit"
              ><Icon name="edit" size={12} style={{verticalAlign:"-0.125em"}} /> 编辑智能体</button>
              <button
                onClick={() => { setCtxMenu(null); setDeleteFor(ctxMenu.name); }}
                className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
                data-testid="gallery-ctx-delete"
              ><Icon name="trash" size={12} style={{verticalAlign:"-0.125em"}} /> 删除</button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* 删除二次确认 */}
      {deleteFor && (
        <div data-testid="gallery-delete-confirm">
          <ConfirmDialog
            title="删除智能体"
            message={`确定删除智能体「${agents.find(a => a.displayName === deleteFor)?.displayName ?? deleteFor}」吗？此操作不可撤销。`}
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
    </Modal>
  );
}
