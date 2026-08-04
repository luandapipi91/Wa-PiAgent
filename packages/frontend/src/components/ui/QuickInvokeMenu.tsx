import { useEffect, useRef } from "react";
import type { SkillSource } from "@wa-pi/shared";
import { AgentMenuItem } from "./AgentMenuItem";

export interface MenuItem {
  id: string;
  name: string;
  description?: string;
  path?: string;
  source?: SkillSource;
  isDir?: boolean;
  avatar?: string;
  avatarColor?: string;
  disabled?: boolean;
}

interface Props {
  type: "agent" | "file" | "skill" | "command";
  items: MenuItem[];
  highlightedIndex: number;
  onSelect: (item: MenuItem) => void;
  onHover: (index: number) => void;
  emptyText?: string;
}

/** 来源标签文本 */
function sourceLabel(source?: SkillSource): string | null {
  if (!source) return null;
  switch (source.type) {
    case "builtin": return "内置";
    case "project": return "项目";
    case "user": return "用户";
    case "extension": return source.name ?? "扩展";
    default: return null;
  }
}

export function QuickInvokeMenu({ type, items, highlightedIndex, onSelect, onHover, emptyText }: Props) {
  const highlightedElRef = useRef<HTMLElement | null>(null);

  // 键盘上下导航时，让高亮项自动滚动到可视区域内
  useEffect(() => {
    highlightedElRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div
      data-testid="quick-invoke-menu"
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[560px] max-w-[calc(100vw-2rem)] max-h-[320px] overflow-y-auto bg-surface border border-hairline rounded-xl shadow-xl z-50 p-1.5"
    >
      {items.length === 0 ? (
        <div className="px-4 py-3 text-sm text-tertiary text-center">
          {emptyText ?? "无匹配结果"}
        </div>
      ) : type === "agent" ? (
        // @ 智能体：复用 AgentMenuItem，与 AgentDropdown 视觉完全一致
        <div className="flex flex-col gap-0.5">
          {items.map((item, i) => (
            <AgentMenuItem
              key={item.id}
              name={item.name}
              description={item.description}
              avatar={item.avatar}
              avatarColor={item.avatarColor}
              highlighted={i === highlightedIndex}
              onClick={item.disabled ? undefined : () => onSelect(item)}
              onMouseEnter={() => onHover(i)}
              innerRef={i === highlightedIndex ? (el) => { highlightedElRef.current = el; } : undefined}
              testId={`quick-invoke-item-${i}`}
            />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((item, i) => (
            <li
              key={item.id}
              ref={i === highlightedIndex ? highlightedElRef as any : undefined}
              data-testid={`quick-invoke-item-${i}`}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                item.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
              } ${
                i === highlightedIndex && !item.disabled ? "bg-accent-soft" : !item.disabled ? "hover:bg-surface-hover" : ""
              }`}
              onClick={item.disabled ? undefined : () => onSelect(item)}
              onMouseEnter={() => onHover(i)}
            >
              {type === "file" ? (
                <>
                  <span className="w-7 h-7 rounded-md bg-surface-hover flex items-center justify-center text-sm flex-shrink-0">{item.isDir ? "📁" : "📄"}</span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-primary truncate">{item.name}</span>
                    {item.path && (
                      <span className="text-xs text-tertiary truncate">{item.path}</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <span className="w-7 h-7 rounded-md bg-surface-hover flex items-center justify-center text-sm flex-shrink-0">⚡</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-primary truncate">{item.name}</span>
                    {item.description && (
                      <span className="text-xs text-tertiary truncate">{item.description}</span>
                    )}
                  </div>
                  {sourceLabel(item.source) && (
                    <span className="text-[calc(11px*var(--font-scale))] leading-4 text-tertiary px-1.5 py-0.5 border border-hairline rounded-md flex-shrink-0">
                      {sourceLabel(item.source)}
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

