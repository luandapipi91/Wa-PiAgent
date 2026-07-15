import { useState } from "react";
import { useSkillsStore } from "../../store/skills";
import { DirTreePicker } from "../DirTreePicker";

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

  return (
    <div className="flex flex-col gap-3 p-4 overflow-auto">
      {/* 技能目录（上方，默认折叠） */}
      <div className="flex flex-col gap-1">
        <button
          onClick={() => setDirExpanded(!dirExpanded)}
          className="flex items-center gap-2 text-sm text-primary text-left"
          data-testid="skill-dir-toggle"
        >
          {/* 仅折叠态显示内置目录路径；展开态下路径已在列表中以 [内置] 呈现，避免重复 */}
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

      {/* 已加载技能（下方） */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-tertiary uppercase tracking-wide">已加载技能</span>
          <button
            onClick={() => load()}
            className="text-xs text-secondary hover:text-primary border border-hairline rounded-sm px-2 py-0.5"
            data-testid="skill-refresh-btn"
          >刷新技能</button>
        </div>
        {allSkills.length === 0 && (
          <span className="text-sm text-tertiary py-2">暂无技能，添加技能目录后自动扫描</span>
        )}
        {allSkills.map(skill => {
          const disabled = disabledSkills.includes(skill.name);
          const expanded = expandedSkills.has(skill.name);
          return (
            <div key={skill.name}>
              <div
                className="flex items-center gap-2 py-1 cursor-pointer select-none"
                style={{ opacity: disabled ? 0.5 : 1 }}
                onClick={() => toggleExpand(skill.name)}
              >
                <input
                  type="checkbox"
                  checked={!disabled}
                  onChange={(e) => { e.stopPropagation(); toggleSkill(skill.name); }}
                  data-testid={`skill-checkbox-${skill.name}`}
                  className="cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="text-sm text-primary">{skill.name}</span>
                <span className="text-xs text-tertiary">{expanded ? "▾" : "▸"}</span>
                {disabled && <span className="text-xs" style={{ color: "var(--danger)" }}>[禁用]</span>}
              </div>
              {expanded && (
                <div className="pl-7 pb-1">
                  <span className="text-xs text-tertiary">{skill.description}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

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
