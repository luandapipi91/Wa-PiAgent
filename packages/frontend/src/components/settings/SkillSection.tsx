import { useState } from "react";
import { useSkillsStore } from "../../store/skills";
import { DirTreePicker } from "../DirTreePicker";
import type { SkillInfo, SkillSourceType } from "@hiagent/shared";

/** 分组定义：label + source 类型过滤 */
interface SkillGroup {
  key: string;
  label: string;
  types: SkillSourceType[];
}

const GROUPS: SkillGroup[] = [
  { key: "builtin", label: "内置技能", types: ["builtin"] },
  { key: "local", label: "个人技能", types: ["project", "user"] },
  { key: "extension", label: "Plugin 技能", types: ["extension"] },
];

/** 判断技能属于哪个分组 */
function getGroupKey(source?: { type: SkillSourceType; name?: string }): string {
  if (!source) return "builtin"; // 无 source 按内置处理
  if (source.type === "extension") return "extension";
  if (source.type === "project" || source.type === "user") return "local";
  return "builtin";
}

/** 来源标签文本 */
function sourceLabel(source?: { type: SkillSourceType; name?: string }): string | null {
  if (!source) return null;
  if (source.type === "builtin") return "内置";
  if (source.type === "project") return "项目";
  if (source.type === "user") return "个人";
  if (source.type === "extension") return source.name ?? "Plugin";
  return null;
}

export function SkillSection() {
  const { allSkills, dirs, disabledSkills, builtinDir, toggleSkill, addDir, removeDir, load } = useSkillsStore();
  const [dirExpanded, setDirExpanded] = useState(true);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  const toggleExpand = (name: string) => {
    setExpandedSkills(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  // 按分组归类技能
  const grouped = new Map<string, SkillInfo[]>();
  for (const g of GROUPS) grouped.set(g.key, []);
  for (const skill of allSkills) {
    const key = getGroupKey(skill.source);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(skill);
    else grouped.get("builtin")!.push(skill);
  }

  // 过滤掉空分组
  const visibleGroups = GROUPS.filter(g => grouped.get(g.key)!.length > 0);

  return (
    <div className="flex flex-col gap-3 p-4 overflow-auto">
      {/* 技能目录（上方，默认展开） */}
      <div className="flex flex-col gap-1">
        <button
          onClick={() => setDirExpanded(!dirExpanded)}
          className="flex items-center gap-2 text-sm text-primary text-left"
          data-testid="skill-dir-toggle"
        >
          <span>技能目录{!dirExpanded ? `：${builtinDir}` : ""}</span>
          <span>{dirExpanded ? "▾" : "▸"}</span>
        </button>

        {dirExpanded && (
          <div className="flex flex-col gap-1 pl-4">
            {dirs.map(dir => (
              <div key={dir} className="flex items-center justify-between py-1">
                <span className="text-sm text-secondary">{dir}</span>
                {dir === builtinDir ? (
                  <span className="text-xs text-tertiary">[内置]</span>
                ) : (
                  <button
                    onClick={() => removeDir(dir)}
                    className="text-xs text-secondary hover:text-danger"
                    data-testid={`skill-dir-remove-${dir}`}
                  >删除</button>
                )}
              </div>
            ))}
            <button
              onClick={() => setShowDirPicker(true)}
              className="self-end px-2 py-1 text-xs text-secondary border border-hairline rounded-sm hover:text-primary mt-1"
              data-testid="skill-add-dir-btn"
            >+ 添加技能目录</button>
          </div>
        )}
      </div>

      {/* 刷新按钮 */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => load()}
          className="text-xs text-secondary hover:text-primary border border-hairline rounded-sm px-2 py-0.5"
          data-testid="skill-refresh-btn"
        >刷新技能</button>
      </div>

      {/* 技能分组列表 */}
      {allSkills.length === 0 && (
        <span className="text-sm text-tertiary py-2">暂无技能，添加技能目录后自动扫描</span>
      )}

      {visibleGroups.map(group => {
        const items = grouped.get(group.key)!;
        return (
          <div key={group.key} className="flex flex-col gap-1">
            {/* 分组标题 */}
            <div className="text-xs font-bold text-secondary tracking-wide border-b border-hairline pb-1 mb-1">
              {group.label} {items.length} 项
            </div>

            {items.map(skill => {
              const disabled = disabledSkills.includes(skill.name);
              const expanded = expandedSkills.has(skill.name);
              const tag = sourceLabel(skill.source);

              return (
                <div
                  key={skill.name}
                  className="flex flex-col py-1.5 cursor-pointer select-none"
                  style={{ opacity: disabled ? 0.5 : 1 }}
                  onClick={() => toggleExpand(skill.name)}
                  data-testid={`skill-row-${skill.name}`}
                >
                  {/* 行头部：checkbox + 名称 + 标签 + 展开箭头 */}
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!disabled}
                      onChange={(e) => { e.stopPropagation(); toggleSkill(skill.name); }}
                      data-testid={`skill-checkbox-${skill.name}`}
                      className="cursor-pointer shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="text-sm font-semibold text-primary">{skill.name}</span>
                    {tag && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full"
                        style={{ background: "var(--hairline)", color: "var(--text-tertiary)" }}
                      >{tag}</span>
                    )}
                    {disabled && (
                      <span className="text-[10px] font-semibold" style={{ color: "var(--danger)" }}>禁用</span>
                    )}
                    <span className="text-xs text-tertiary ml-auto">{expanded ? "▾" : "▸"}</span>
                  </div>

                  {/* 描述 */}
                  {expanded && skill.description && (
                    <div className="pl-6 pt-1">
                      <span className="text-[11px] text-tertiary">{skill.description}</span>
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
