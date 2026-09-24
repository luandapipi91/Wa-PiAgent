import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillInfo, SkillDir } from "@wa-pi/shared";
import { withTimeout, scanSkillsDir, SKILL_SCAN_TIMEOUT_MS } from "./skill-utils";

/** settings.json 中与技能相关的字段 */
interface SkillSettings {
  /**
   * 被禁用的技能名。
   * 历史字段 userSkillDirs（手动添加的技能目录）已废弃：技能目录改为自动发现
   * （项目 <cwd>/.pi/skills → 内置 ~/.pi/agent/skills → 扩展包），不再读写该字段；
   * writeSettings 会原样保留文件中已有的旧值。
   */
  disabledSkills?: string[];
  [k: string]: unknown;
}

/** 扩展包技能来源（由 extension-manager.getEnabledExtensionSkillPaths 提供） */
export interface ExtensionSkillSource {
  path: string;
  packageName: string;
}

/** scan() 入参 */
export interface ScanOptions {
  /** 项目技能来源（数组顺序即项目技能扫描顺序，排在所有其他来源之前） */
  projects?: { id: string; name: string; dir: string }[];
  /** 扩展包技能目录 */
  extensionSkillPaths?: ExtensionSkillSource[];
}

/** scan() 返回结构 */
interface ScanResult {
  skills: SkillInfo[];
  allSkills: SkillInfo[];
  dirs: SkillDir[];
  disabledSkills: string[];
  builtinDir: string;
}

/**
 * 技能管理器：扫描/按来源优先级聚合/启用禁用。
 * 数据持久化在 dataDir/settings.json 的 disabledSkills 字段。
 * 使用自实现轻量异步递归扫描（不依赖 Pi SDK loadSkills），硬限制深度、条目数和超时。
 * 技能目录不再由用户手动添加/删除，来源固定为 项目 → 内置 → 扩展包。
 */
export class SkillManager {
  /** 内置技能目录（dataDir/skills），不可删除 */
  private builtinDir: string;

  /**
   * @param dataDir WaPi 数据目录，内置技能目录 = dataDir/skills
   */
  constructor(private dataDir: string) {
    this.builtinDir = join(dataDir, "skills");
  }

  // ---- settings.json 读写 ----

  /** 读取 settings.json（不存在则返回 {}） */
  private async readSettings(): Promise<SkillSettings> {
    try {
      const raw = await readFile(join(this.dataDir, "settings.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /** 写 settings.json（保留其他字段，包括已废弃的 userSkillDirs 旧值） */
  private async writeSettings(settings: SkillSettings): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(
      join(this.dataDir, "settings.json"),
      JSON.stringify(settings, null, 2),
      "utf8",
    );
  }

  // ---- 公共 API ----

  /**
   * 扫描所有技能目录：项目目录 → 内置目录 → 扩展包。
   * 同名技能先到者胜（项目 > 内置 > 扩展），被遮蔽者保留在 allSkills 并标记 shadowed。
   */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const { projects = [], extensionSkillPaths = [] } = options;
    const settings = await this.readSettings();
    const disabledSkills = settings.disabledSkills ?? [];

    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];
    const dirs: SkillDir[] = [];

    /** 合并一批扫描结果：同名首见者生效，后续出现者标记 shadowed 但仍保留 */
    const merge = (list: SkillInfo[]): void => {
      for (const skill of list) {
        if (seen.has(skill.name)) skill.shadowed = true;
        else seen.add(skill.name);
        allSkills.push(skill);
      }
    };

    // 1. 项目技能目录（优先级最高）
    for (const project of projects) {
      dirs.push({
        path: project.dir,
        type: "project",
        projectId: project.id,
        projectName: project.name,
      });
      try {
        const list = await withTimeout(
          scanSkillsDir(project.dir, {
            type: "project",
            projectId: project.id,
            projectName: project.name,
          }),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描项目技能目录超时: ${project.dir}`,
        );
        merge(list);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[skill-manager] 扫描项目技能目录失败或超时，已跳过: ${project.dir} (${reason})`,
        );
      }
    }

    // 2. 内置目录
    dirs.push({ path: this.builtinDir, type: "builtin" });
    try {
      const list = await withTimeout(
        scanSkillsDir(this.builtinDir, { type: "builtin" }),
        SKILL_SCAN_TIMEOUT_MS,
        `扫描目录超时: ${this.builtinDir}`,
      );
      merge(list);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[skill-manager] 扫描目录失败或超时，已跳过: ${this.builtinDir} (${reason})`,
      );
    }

    // 3. 扩展技能目录
    for (const ext of extensionSkillPaths) {
      dirs.push({ path: ext.path, type: "extension", name: ext.packageName });
      try {
        const list = await withTimeout(
          scanSkillsDir(ext.path, { type: "extension", name: ext.packageName }),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描扩展技能目录超时: ${ext.path}`,
        );
        merge(list);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[skill-manager] 扫描扩展技能目录失败或超时，已跳过: ${ext.path} (${reason})`,
        );
      }
    }

    // 生效技能 = 未被遮蔽 且 未被禁用
    const skills = allSkills.filter(
      (s) => !s.shadowed && !disabledSkills.includes(s.name),
    );

    return { skills, allSkills, dirs, disabledSkills, builtinDir: this.builtinDir };
  }

  /**
   * 启用或禁用指定技能。
   * @param skillName 技能名
   * @param disabled true=禁用，false=启用
   */
  async toggleSkill(skillName: string, disabled: boolean): Promise<void> {
    const settings = await this.readSettings();
    const list = settings.disabledSkills ?? [];
    if (disabled) {
      if (!list.includes(skillName)) {
        settings.disabledSkills = [...list, skillName];
        await this.writeSettings(settings);
      }
    } else {
      if (!list.includes(skillName)) return;
      settings.disabledSkills = list.filter((n) => n !== skillName);
      await this.writeSettings(settings);
    }
  }
}
