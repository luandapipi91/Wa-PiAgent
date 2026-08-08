import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSkillsStore } from "../store/skills";
import { useSettingsStore } from "../store/settings";
import { useAgentsStore } from "../store/agents";
import { useTranslation } from "../i18n/useTranslation";

/** 调色板中的一项 */
interface PaletteItem {
  id: string;
  title: string;
  hint?: string;
  group: string;
  keywords?: string[];
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 模糊匹配：每个空格分隔的 token 必须在候选 haystack 中按顺序出现（大小写不敏感） */
function fuzzyMatch(item: PaletteItem, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/);
  if (tokens.length === 0) return true;
  const hay = [item.title, item.hint ?? "", ...(item.keywords ?? [])].join("\n").toLowerCase();
  let cursor = 0;
  for (const tok of tokens) {
    const at = hay.indexOf(tok, cursor);
    if (at < 0) return false;
    cursor = at + tok.length;
  }
  return true;
}

export function CommandPalette({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const skills = useSkillsStore(s => s.allSkills ?? []);
  const agents = useAgentsStore(s => s.list ?? []);

  // 构建命令项
  const commandItems = useMemo<PaletteItem[]>(() => [
    {
      id: "cmd-settings",
      group: t("commandPalette.groupCommands"),
      title: t("composer.cmdSettings"),
      hint: t("commandPalette.settingsFullHint"),
      keywords: ["settings", "设置", "配置"],
      run: () => { onClose(); useSettingsStore.getState().open(); },
    },
    {
      id: "cmd-agents",
      group: t("commandPalette.groupCommands"),
      title: t("composer.cmdAgents"),
      hint: t("composer.cmdAgentsDesc"),
      keywords: ["agent", "智能体", "agents"],
      run: () => { onClose(); window.dispatchEvent(new CustomEvent("wa-pi:open-gallery")); },
    },
  ], [onClose, t]);

  // 构建技能项
  const skillItems = useMemo<PaletteItem[]>(() =>
    skills.map(s => ({
      id: `skill-${s.name}`,
      group: t("commandPalette.groupSkills"),
      title: s.name,
      hint: s.description,
      keywords: [s.name, s.description],
      run: () => { onClose(); /* 将技能名写入剪贴板，方便用户在输入框中用 $[技能名] 引用 */ },
    })),
  [skills, onClose, t]);

  // 合并所有项：命令在前，技能在后
  const allItems = useMemo(() => [...commandItems, ...skillItems], [commandItems, skillItems]);

  // 根据查询过滤
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    return allItems.filter(item => fuzzyMatch(item, query));
  }, [query, allItems]);

  // 分组
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const item of filtered) {
      const group = map.get(item.group) ?? [];
      group.push(item);
      map.set(item.group, group);
    }
    return [...map.entries()];
  }, [filtered]);

  // 扁平列表（用于键盘导航索引计算）
  const flat = useMemo(() => filtered, [filtered]);

  // 查询变化时重置高亮
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // 自动聚焦
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // 延迟聚焦确保 DOM 就绪
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 键盘事件
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx(i => (flat.length === 0 ? 0 : (i + 1) % flat.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(i => (flat.length === 0 ? 0 : i <= 0 ? flat.length - 1 : i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = flat[activeIdx];
        if (item) {
          item.run();
          onClose();
        }
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, flat, activeIdx, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-start justify-center z-[60] pt-[15vh]"
      style={{ background: "rgba(0,0,0,0.2)" }}
      onClick={onClose}
      data-testid="command-palette-overlay"
    >
      <div
        className="rounded-xl flex flex-col border border-hairline shadow-2xl"
        style={{ background: "var(--surface)", width: 560, maxHeight: "60vh" }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-hairline">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--tertiary)" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-tertiary"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("commandPalette.searchPlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded border border-hairline text-tertiary">
            esc
          </kbd>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto py-2 min-h-0">
          {flat.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-tertiary">{t("commandPalette.emptyResult")}</div>
          ) : (
            grouped.map(([groupName, items]) => {
              let running = 0;
              return (
                <div key={groupName} className="mb-1">
                  <div className="px-4 py-1.5 text-[calc(11px*var(--font-scale))] font-semibold text-tertiary tracking-wide uppercase">
                    {groupName}
                  </div>
                  {items.map(item => {
                    const idx = running;
                    running++;
                    // 在全局 flat 数组中找到该项的索引
                    const globalIdx = flat.indexOf(item);
                    const isActive = globalIdx === activeIdx;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={isActive ? "true" : "false"}
                        className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
                          isActive ? "bg-surface-hover" : "hover:bg-surface-hover/50"
                        }`}
                        onMouseEnter={() => setActiveIdx(globalIdx)}
                        onClick={() => {
                          item.run();
                        }}
                      >
                        <span className="flex-1 min-w-0">
                          <span className="text-sm text-primary font-medium block truncate">{item.title}</span>
                          {item.hint && (
                            <span className="text-[calc(11px*var(--font-scale))] text-tertiary block truncate mt-0.5">{item.hint}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-hairline text-[calc(10px*var(--font-scale))] text-tertiary">
          <span><kbd className="px-1 rounded border border-hairline">↑↓</kbd> {t("commandPalette.hintNavigate")}</span>
          <span><kbd className="px-1 rounded border border-hairline">↩</kbd> {t("commandPalette.hintRun")}</span>
          <span><kbd className="px-1 rounded border border-hairline">esc</kbd> {t("common.close")}</span>
        </div>
      </div>
    </div>
  );
}
