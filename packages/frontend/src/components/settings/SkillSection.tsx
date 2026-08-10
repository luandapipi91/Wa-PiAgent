import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { useSkillsStore } from "../../store/skills";
import { DirTreePicker } from "../DirTreePicker";
import type { SkillInfo, SkillSourceType } from "@wa-pi/shared";

/** 分组定义：labelKey（i18n key）+ source 类型过滤 */
interface SkillGroup {
  key: string;
  labelKey: string;
  types: SkillSourceType[];
}

const GROUPS: SkillGroup[] = [
  { key: "builtin", labelKey: "settings.skill.groupBuiltin", types: ["builtin"] },
  { key: "local", labelKey: "settings.skill.groupLocal", types: ["project", "user"] },
  { key: "extension", labelKey: "settings.skill.groupExtension", types: ["extension"] },
];

/** 判断技能属于哪个分组 */
function getGroupKey(source?: { type: SkillSourceType; name?: string }): string {
  if (!source) return "builtin"; // 无 source 按内置处理
  if (source.type === "extension") return "extension";
  if (source.type === "project" || source.type === "user") return "local";
  return "builtin";
}

export function SkillSection() {
  const { allSkills, dirs, disabledSkills, builtinDir, toggleSkill, addDir, removeDir, load } = useSkillsStore();
  const { t } = useTranslation();
  const [dirExpanded, setDirExpanded] = useState(true);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  /** 来源标签文本 */
  const sourceLabel = (source?: { type: SkillSourceType; name?: string }): string | null => {
    if (!source) return null;
    if (source.type === "builtin") return t("settings.skill.sourceBuiltin");
    if (source.type === "project") return t("settings.skill.sourceProject");
    if (source.type === "user") return t("settings.skill.sourceUser");
    if (source.type === "extension") return source.name ?? t("settings.skill.sourceExtension");
    return null;
  };

  const toggleExpand = (name: string) => {
    setExpandedSkills(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  // 搜索过滤：按技能名称匹配（大小写不敏感）
  const keyword = search.trim().toLowerCase();
  const filteredSkills = keyword
    ? allSkills.filter(s => s.name.toLowerCase().includes(keyword))
    : allSkills;

  // 按分组归类技能
  const grouped = new Map<string, SkillInfo[]>();
  for (const g of GROUPS) grouped.set(g.key, []);
  for (const skill of filteredSkills) {
    const key = getGroupKey(skill.source);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(skill);
    else grouped.get("builtin")!.push(skill);
  }

  // 过滤掉空分组
  const visibleGroups = GROUPS.filter(g => grouped.get(g.key)!.length > 0);

  return (
    <div className="flex flex-col gap-3 p-4 overflow-auto">
      {/* 技能目录（上方，默认展开）：标题与操作 icon 同行，icon 右对齐 */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setDirExpanded(!dirExpanded)}
            className="flex items-center gap-2 text-sm text-primary text-left"
            data-testid="skill-dir-toggle"
          >
            <span>{t("settings.skill.dirTitle")}{!dirExpanded ? `：${builtinDir}` : ""}</span>
            <span>{dirExpanded ? "▾" : "▸"}</span>
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowDirPicker(true)}
              className="p-1 text-secondary hover:text-primary"
              title={t("settings.skill.addDir")}
              aria-label={t("settings.skill.addDir")}
              data-testid="skill-add-dir-btn"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" /><path d="M12 5v14" />
              </svg>
            </button>
            <button
              onClick={() => load()}
              className="p-1 text-secondary hover:text-primary"
              title={t("settings.skill.refresh")}
              aria-label={t("settings.skill.refresh")}
              data-testid="skill-refresh-btn"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
              </svg>
            </button>
          </div>
        </div>

        {dirExpanded && (
          <div className="flex flex-col gap-1 pl-4">
            {dirs.map(dir => (
              <div key={dir} className="flex items-center justify-between py-1">
                <span className="text-sm text-secondary">{dir}</span>
                {dir === builtinDir ? (
                  <span className="text-xs text-tertiary">{t("settings.skill.builtinTag")}</span>
                ) : (
                  <button
                    onClick={() => removeDir(dir)}
                    className="text-xs text-secondary hover:text-danger"
                    data-testid={`skill-dir-remove-${dir}`}
                  >{t("settings.skill.deleteDir")}</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 搜索框：输入即实时过滤技能 */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("settings.skill.searchPlaceholder")}
        className="px-2 py-1 text-sm text-primary bg-transparent border border-hairline rounded-sm outline-none"
        data-testid="skill-search-input"
      />

      {/* 技能分组列表 */}
      {allSkills.length === 0 && (
        <span className="text-sm text-tertiary py-2">{t("settings.skill.empty")}</span>
      )}
      {allSkills.length > 0 && filteredSkills.length === 0 && (
        <span className="text-sm text-tertiary py-2">{t("settings.skill.noMatch")}</span>
      )}

      {visibleGroups.map(group => {
        const items = grouped.get(group.key)!;
        return (
          <div key={group.key} className="flex flex-col gap-1">
            {/* 分组标题 */}
            <div className="text-xs font-bold text-secondary tracking-wide border-b border-hairline pb-1 mb-1">
              {t(group.labelKey)} {t("settings.skill.itemCount", { count: items.length })}
            </div>

            {items.map(skill => {
              const disabled = disabledSkills.includes(skill.name);
              const expanded = expandedSkills.has(skill.name);
              const tag = sourceLabel(skill.source);

              return (
                <div
                  key={skill.name}
                  className="flex flex-col py-1.5 select-none"
                  style={{ opacity: disabled ? 0.5 : 1 }}
                  data-testid={`skill-row-${skill.name}`}
                >
                  {/* 行头部：名称 + 标签 + 展开箭头（左）| switch 开关（右） */}
                  <div
                    className="flex items-center gap-2 cursor-pointer"
                    onClick={() => toggleExpand(skill.name)}
                  >
                    <span className="text-sm font-semibold text-primary">{skill.name}</span>
                    {tag && (
                      <span className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full"
                        style={{ background: "var(--hairline)", color: "var(--text-tertiary)" }}
                      >{tag}</span>
                    )}
                    {disabled && (
                      <span className="text-[calc(10px*var(--font-scale))] font-semibold" style={{ color: "var(--danger)" }}>{t("settings.skill.disabled")}</span>
                    )}
                    <span className="text-xs text-tertiary flex-1">{expanded ? "▾" : "▸"}</span>

                    {/* switch 开关，最右侧 */}
                    <div
                      onClick={(e) => { e.stopPropagation(); toggleSkill(skill.name); }}
                      className="relative shrink-0 cursor-pointer"
                      style={{
                        width: 38, height: 22, borderRadius: 9999,
                        background: disabled ? "var(--hairline-strong)" : "var(--brand)",
                        transition: "background 0.2s",
                      }}
                      data-testid={`skill-switch-${skill.name}`}
                      data-on={disabled ? "false" : "true"}
                    >
                      <span
                        className="absolute top-0.5 rounded-full bg-white transition-all"
                        style={{
                          width: 18, height: 18,
                          left: disabled ? 2 : undefined,
                          right: disabled ? undefined : 2,
                          boxShadow: "0 1px 2px rgba(0,0,0,.1)",
                        }}
                      />
                    </div>
                  </div>

                  {/* 描述 */}
                  {expanded && skill.description && (
                    <div className="pl-0 pt-1">
                      <span className="text-[calc(11px*var(--font-scale))] text-tertiary">{skill.description}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* 添加目录选择器 */}
      {showDirPicker && (
        <DirTreePicker
          onPick={(path) => { addDir(path); setShowDirPicker(false); }}
          onCancel={() => setShowDirPicker(false)}
        />
      )}
    </div>
  );
}
