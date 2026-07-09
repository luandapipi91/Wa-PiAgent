import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillInfo } from "@hiagent/shared";

/** settings.json 中与技能相关的字段 */
interface SkillSettings {
  skills?: string[];
  disabledSkills?: string[];
  [k: string]: unknown;
}

/** scan() 返回结构 */
interface ScanResult {
  skills: SkillInfo[];
  allSkills: SkillInfo[];
  dirs: string[];
  disabledSkills: string[];
  builtinDir: string;
}

/**
 * 技能管理器：扫描/去重/目录管理/启用禁用。
 * 数据持久化在 dataDir/settings.json 的 skills / disabledSkills 字段，
 * 技能扫描委托给 Pi SDK 的 loadSkills()。
 */
export class SkillManager {
  /** 内置技能目录（dataDir/skills），不可删除 */
  private builtinDir: string;

  /**
   * @param dataDir HiAgent 数据目录，内置技能目录 = dataDir/skills
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

  /** 写 settings.json（保留其他字段） */
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
   * 扫描所有技能目录，返回去重 + 禁用过滤后的技能列表。
   * 扫描顺序：内置目录优先，然后 settings.skills 中的用户目录。
   */
  async scan(): Promise<ScanResult> {
    const settings = await this.readSettings();
    const userDirs = settings.skills ?? [];
    const disabledSkills = settings.disabledSkills ?? [];

    // 用 Pi SDK loadSkills 扫描
    // 内置目录放在 skillPaths 第一位确保优先去重
    // includeDefaults = false → 不扫 Pi 默认的 ~/.pi/agent/skills/ 等
    const { loadSkills } = await import("@earendil-works/pi-coding-agent");
    const result = loadSkills({
      cwd: this.dataDir,
      agentDir: this.dataDir,
      skillPaths: [this.builtinDir, ...userDirs],
      includeDefaults: false,
    });

    // 去重：loadSkills 内部已处理同名冲突（先扫到的优先），此处二次确保内置目录优先
    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];
    for (const skill of result.skills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        allSkills.push({ name: skill.name, description: skill.description });
      }
    }

    // 过滤禁用技能
    const skills = allSkills.filter(s => !disabledSkills.includes(s.name));

    // 目录列表：内置目录在第一位
    const dirs = [this.builtinDir, ...userDirs];

    return { skills, allSkills, dirs, disabledSkills, builtinDir: this.builtinDir };
  }

  /**
   * 添加用户技能目录。
   * @throws 目录不存在时抛出 "目录不存在"
   */
  async addDir(path: string): Promise<void> {
    if (!existsSync(path)) throw new Error("目录不存在");
    if (path === this.builtinDir) throw new Error("内置目录无需重复添加");
    const settings = await this.readSettings();
    const dirs = settings.skills ?? [];
    if (!dirs.includes(path)) {
      dirs.push(path);
      settings.skills = dirs;
      await this.writeSettings(settings);
    }
  }

  /**
   * 删除用户技能目录（从 settings.json 移除）。
   * @throws 尝试删除内置目录时抛出 "内置目录不可删除"
   */
  async removeDir(path: string): Promise<void> {
    if (path === this.builtinDir) throw new Error("内置目录不可删除");
    const settings = await this.readSettings();
    const dirs = settings.skills ?? [];
    if (!dirs.includes(path)) return;
    settings.skills = dirs.filter(d => d !== path);
    await this.writeSettings(settings);
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
      settings.disabledSkills = list.filter(n => n !== skillName);
      await this.writeSettings(settings);
    }
  }
}
