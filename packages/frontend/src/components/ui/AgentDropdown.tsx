import { useEffect, useRef, useState } from "react";
import type { AgentConfig, AgentName } from "@wa-pi/shared";
import { filterItems } from "../../quick-invoke/trigger";
import { AgentMenuItem } from "./AgentMenuItem";

interface Props {
  agents: AgentConfig[];
  value: AgentName | null;
  onPick: (name: AgentName) => void;
  /** value 在 agents 中找不到（已删除）时 pill 显示警示态 */
  missing?: boolean;
  placeholder?: string;
  /** pill 按钮的 testid，默认 "agent-select" */
  pillTestId?: string;
  /** 搜索框/列表项 testid 前缀，默认 "agent"（衍生 ${prefix}-search / ${prefix}-item-${name} / ${prefix}-missing） */
  itemTestIdPrefix?: string;
}

/**
 * 智能体选择下拉（pill 按钮 + 搜索框 + 列表）。
 * 纯展示受控组件：不读 session、不发 WS、不弹确认框。
 * 用于 NewSessionPane（新建会话选智能体）与 AgentSwitcher（复用同一 UI，外层包确认框）。
 * 列表项渲染复用 AgentMenuItem，与 QuickInvokeMenu 的 @ 智能体弹窗视觉一致。
 */
export function AgentDropdown({
  agents, value, onPick, missing = false, placeholder,
  pillTestId = "agent-select", itemTestIdPrefix = "agent",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击组件外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = agents.find(a => a.displayName === value);
  const showMissing = missing || (!current && !!value);
  // 按 displayName（用户可见名称）+ description 过滤；filterItems 默认取 item.name，故映射为 displayName
  const filtered = filterItems(
    agents.map(a => ({ agent: a, name: a.displayName, description: a.description })),
    query,
  ).map(({ agent }) => agent);

  const closeMenu = () => { setOpen(false); setQuery(""); };
  const handlePick = (name: AgentName) => {
    // 选择当前项：不触发 onPick，直接关闭
    if (name === value) { closeMenu(); return; }
    onPick(name);
    closeMenu();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid={pillTestId}
        onClick={() => { setOpen(o => !o); setQuery(""); }}
        className={`min-w-0 flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[12px] cursor-pointer transition-colors ${
          showMissing
            ? "bg-warning-soft text-warning border-warning-soft"
            : "bg-surface-elevated text-secondary border-hairline hover:text-primary"
        }`}
      >
        {showMissing ? (
          <span data-testid={`${itemTestIdPrefix}-missing`}>⚠️ 原智能体已删除，点击重选 ▾</span>
        ) : current ? (
          <>
            <span
              className="w-[18px] h-[18px] rounded-sm flex items-center justify-center text-[11px] flex-none"
              style={{ background: current.avatarColor?.includes("-")
                ? `linear-gradient(135deg, ${current.avatarColor.split("-").map(s => s.trim()).join(", ")})`
                : current.avatarColor || undefined }}
            >{current.avatar}</span>
            <span className="max-w-[180px] truncate">{current.displayName}</span>
            <span style={{ fontSize: 10 }}>▾</span>
          </>
        ) : (
          <>
            <span className="text-tertiary">{placeholder ?? "选择智能体"}</span>
            <span style={{ fontSize: 10 }}>▾</span>
          </>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[220px] bg-surface-elevated border border-hairline rounded-md shadow-lg p-1">
          <div className="flex items-center gap-1.5 bg-surface border border-hairline rounded-sm px-2 py-1.5 mx-0.5 mb-1 text-tertiary">
            🔍
            <input
              data-testid={`${itemTestIdPrefix}-search`}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索智能体…"
              className="flex-1 bg-transparent border-0 outline-none text-[12px] text-primary"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {filtered.map(a => (
              <AgentMenuItem
                key={a.displayName}
                name={a.displayName}
                description={a.description}
                avatar={a.avatar}
                avatarColor={a.avatarColor}
                selected={a.displayName === value}
                onClick={() => handlePick(a.displayName)}
                testId={`${itemTestIdPrefix}-item-${a.displayName}`}
              />
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-3.5 text-center text-tertiary text-[12px]">无智能体</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
