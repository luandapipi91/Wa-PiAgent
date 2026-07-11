// ===== 技能管理类型定义 =====

/** 技能信息（从 SKILL.md frontmatter 提取的最小集） */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;        // skill 目录绝对路径（含 SKILL.md 的目录），用于喂给 SDK additionalSkillPaths
}

// ===== WS 协议事件（技能管理）=====

// 前端 → kernel
export interface SkillListEvent { type: "skill:list"; }
export interface SkillToggleEvent {
  type: "skill:toggle";
  skillName: string;
  disabled: boolean;          // true=禁用，false=启用
}
export interface SkillDirAddEvent {
  type: "skillDir:add";
  path: string;
}
export interface SkillDirRemoveEvent {
  type: "skillDir:remove";
  path: string;
}

// kernel → 前端（skill:list 和 skill:changed 结构相同）
export interface SkillListResult {
  type: "skill:list";
  skills: SkillInfo[];        // 已启用的技能（过滤禁用 + 去重后）
  allSkills: SkillInfo[];     // 全部扫描出的技能（含禁用的，用于 UI 灰显）
  dirs: string[];             // 技能目录列表（含内置目录，内置在第一位）
  disabledSkills: string[];   // 被禁用的技能名
  builtinDir: string;         // 内置目录路径（告诉前端哪个不可删）
}

export interface SkillChangedEvent {
  type: "skill:changed";
  skills: SkillInfo[];
  allSkills: SkillInfo[];
  dirs: string[];
  disabledSkills: string[];
  builtinDir: string;
}
