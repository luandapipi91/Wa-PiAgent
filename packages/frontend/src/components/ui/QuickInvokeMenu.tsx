import type { SkillSource } from "@hiagent/shared";

export interface MenuItem {
  id: string;
  name: string;
  description?: string;
  path?: string;
  source?: SkillSource;
}

interface Props {
  type: "file" | "skill";
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
  return (
    <div
      data-testid="quick-invoke-menu"
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[400px] max-h-[300px] overflow-y-auto bg-surface border border-hairline rounded-xl shadow-lg z-50"
    >
      {items.length === 0 ? (
        <div className="px-4 py-3 text-sm text-tertiary text-center">
          {emptyText ?? "无匹配结果"}
        </div>
      ) : (
        <ul className="py-1">
          {items.map((item, i) => (
            <li
              key={item.id}
              data-testid={`quick-invoke-item-${i}`}
              className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors ${
                i === highlightedIndex ? "bg-accent-soft" : "hover:bg-surface-hover"
              }`}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(i)}
            >
              {type === "file" ? (
                <>
                  <span className="text-base flex-shrink-0">📄</span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-primary truncate">{item.name}</span>
                    {item.path && (
                      <span className="text-xs text-tertiary truncate">{item.path}</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <span className="text-base flex-shrink-0">⚡</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-primary truncate">{item.name}</span>
                    {item.description && (
                      <span className="text-xs text-tertiary truncate">{item.description}</span>
                    )}
                  </div>
                  {sourceLabel(item.source) && (
                    <span className="text-xs text-tertiary px-1.5 py-0.5 border border-hairline rounded flex-shrink-0">
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
