import { useState } from "react";
import { useSkillsStore } from "../../store/skills";
import { DirTreePicker } from "../DirTreePicker";

export function SkillSection() {
  const { allSkills, dirs, disabledSkills, builtinDir, toggleSkill, addDir, removeDir } = useSkillsStore();
  const [dirExpanded, setDirExpanded] = useState(false);
  const [showDirPicker, setShowDirPicker] = useState(false);

  return (
    <div className="flex flex-col gap-3 p-4 overflow-auto">
      {/* 技能目录（上方，默认折叠） */}
      <div className="flex flex-col gap-1">
        <button
          onClick={() => setDirExpanded(!dirExpanded)}
          className="flex items-center gap-2 text-sm text-primary text-left"
          data-testid="skill-dir-toggle"
        >
          <span>技能目录：{builtinDir}</span>
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
              className="self-start px-2 py-1 text-xs text-secondary border border-hairline rounded-sm hover:text-primary mt-1"
              data-testid="skill-add-dir-btn"
            >+ 添加技能目录</button>
          </div>
        )}
      </div>

      {/* 已加载技能（下方） */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">已加载技能</span>
        {allSkills.length === 0 && (
          <span className="text-sm text-tertiary py-2">暂无技能，添加技能目录后自动扫描</span>
        )}
        {allSkills.map(skill => {
          const disabled = disabledSkills.includes(skill.name);
          return (
            <label
              key={skill.name}
              className="flex items-center gap-2 py-1 cursor-pointer"
              style={{ opacity: disabled ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={!disabled}
                onChange={() => toggleSkill(skill.name)}
                data-testid={`skill-checkbox-${skill.name}`}
                className="cursor-pointer"
              />
              <span className="text-sm text-primary">{skill.name}</span>
              <span className="text-xs text-tertiary">— {skill.description}</span>
              {disabled && <span className="text-xs" style={{ color: "var(--danger)" }}>[禁用]</span>}
            </label>
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
