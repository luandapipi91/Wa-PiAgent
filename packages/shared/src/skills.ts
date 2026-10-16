// ===== 技能管理类型定义 =====

/**
 * 技能来源类型。
 * 扫描口径：项目目录（project）→ 内置目录（builtin）→ 扩展包（extension）。
 */
export type SkillSourceType = "builtin" | "project" | "extension";

/** 技能来源信息 */
export interface SkillSource {
  type: SkillSourceType;
  /** type === "extension" 时为扩展包名 */
  name?: string;
  /** type === "project" 时为项目 id */
  projectId?: string;
  /** type === "project" 时为项目名，供前端展示「项目 skill（项目名）」 */
  projectName?: string;
}

/** 技能信息（从 SKILL.md frontmatter 提取的最小集） */
export interface SkillInfo {
  name: string;
  description: string;
  /** 技能目录绝对路径（含 SKILL.md 的目录），喂给 pi 的 --skill */
  path: string;
  /** 技能来源，供前端分组与来源标签 */
  source?: SkillSource;
  /**
   * 同名被更高优先级来源遮蔽（项目 > 内置 > 扩展）时为 true。
   * shadowed=true 仍出现在 allSkills（供范围视图展示与开关操作），但不进入 skills、不传给 pi。
   */
  shadowed?: boolean;
}

/** 技能目录项（带范围信息，供技能页只读展示） */
export interface SkillDir {
  /** 目录绝对路径 */
  path: string;
  /** 目录范围 */
  type: SkillSourceType;
  /** type === "project" 时为项目 id */
  projectId?: string;
  /** type === "project" 时为项目名 */
  projectName?: string;
  /** type === "extension" 时为扩展包名 */
  name?: string;
}

// ===== WS 协议事件（技能管理）=====

export interface SkillListEvent {
  type: "skill:list";
}

export interface SkillToggleEvent {
  type: "skill:toggle";
  skillName: string;
  disabled: boolean; // true=禁用，false=启用
}

// kernel → 前端（skill:list 与 skill:changed 结构相同）
export interface SkillListResult {
  type: "skill:list";
  /** 生效技能（非 shadowed 且未禁用） */
  skills: SkillInfo[];
  /** 全部扫描结果（含 shadowed 与被禁用者，供范围视图展示） */
  allSkills: SkillInfo[];
  /** 技能目录清单（顺序：项目 → 内置 → 扩展） */
  dirs: SkillDir[];
  disabledSkills: string[];
  builtinDir: string;
}

export interface SkillChangedEvent {
  type: "skill:changed";
  skills: SkillInfo[];
  allSkills: SkillInfo[];
  dirs: SkillDir[];
  disabledSkills: string[];
  builtinDir: string;
}
