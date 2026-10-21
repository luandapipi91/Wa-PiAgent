import { join } from "node:path";

/** 项目技能来源（由 ProjectStore 的项目列表派生） */
export interface ProjectSkillSource {
  /** 项目 id */
  id: string;
  /** 项目名（写入 SkillSource.projectName，供前端展示） */
  name: string;
  /** 项目技能目录 `<project.cwd>/.pi/skills` */
  dir: string;
}

/**
 * 项目技能目录：<cwd>/.pi/skills（项目维度，与当前会话无关）。
 * 默认工作区项目 cwd = ~/.pi/agent/workdir，故其项目技能目录为 ~/.pi/agent/workdir/.pi/skills。
 * cwd 为空（异常数据）时返回 undefined，调用方跳过项目级扫描。
 */
export function projectSkillsDirOf(cwd?: string): string | undefined {
  return cwd ? join(cwd, ".pi", "skills") : undefined;
}

/** 从项目列表派生技能来源列表：跳过空 cwd，保持项目原有顺序 */
export function collectProjectSkillSources(
  projects: { id: string; name: string; cwd: string }[],
): ProjectSkillSource[] {
  const out: ProjectSkillSource[] = [];
  for (const p of projects) {
    const dir = projectSkillsDirOf(p.cwd);
    if (dir) out.push({ id: p.id, name: p.name, dir });
  }
  return out;
}
