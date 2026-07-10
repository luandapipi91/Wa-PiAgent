import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillInfo } from "@hiagent/shared";

/** settings.json 中与技能相关的字段 */
interface SkillSettings {
  /** 用户技能目录（HiAgent 内部字段，Pi SDK 不读此字段，避免触发 SDK 递归扫描） */
  userSkillDirs?: string[];
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

/** 递归扫描最大深度（skill-dir / skill-name / SKILL.md = 3 层） */
const MAX_DEPTH = 3;
/** 单层目录最多遍历条目数 */
const MAX_PER_DIR = 200;
/** 全量扫描最多访问的条目总数 */
const MAX_TOTAL_ENTRIES = 5000;

/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name 和 description。
 * 格式：`---\nname: xxx\ndescription: yyy\n---`
 */
function parseSkillFrontmatter(content: string): SkillInfo | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) return null;
  return { name, description: desc ?? "" };
}

/**
 * 轻量递归扫描指定目录，查找 SKILL.md 并解析 frontmatter。
 * 硬限制深度和条目数，几万递归文件的目录也能毫秒级完成。
 */
function scanSkillsDir(dir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  let totalEntries = 0;

  function walk(currentDir: string, depth: number) {
    if (depth > MAX_DEPTH || totalEntries >= MAX_TOTAL_ENTRIES) return;
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }
    // 截断超大单层目录
    if (entries.length > MAX_PER_DIR) entries = entries.slice(0, MAX_PER_DIR);

    for (const name of entries) {
      if (totalEntries >= MAX_TOTAL_ENTRIES) break;
      if (name.startsWith(".")) continue; // 跳过隐藏目录/文件
      const fullPath = join(currentDir, name);
      totalEntries++;
      try {
        const st = statSync(fullPath);
        if (st.isDirectory() && depth < MAX_DEPTH) {
          // 先检查当前目录下是否有 SKILL.md（一技能一目录模式）
          const skillFile = join(fullPath, "SKILL.md");
          try {
            const content = readFileSync(skillFile, "utf8");
            const info = parseSkillFrontmatter(content);
            if (info) {
              skills.push(info);
              continue; // 找到 SKILL.md 就不递归进入该目录
            }
          } catch {
            // 没有 SKILL.md，继续递归
          }
          walk(fullPath, depth + 1);
        }
      } catch {
        // 权限不足等，跳过
      }
    }
  }

  walk(dir, 1);
  return skills;
}

/**
 * 技能管理器：扫描/去重/目录管理/启用禁用。
 * 数据持久化在 dataDir/settings.json 的 skills / disabledSkills 字段。
 * 使用自实现轻量递归扫描（不依赖 Pi SDK loadSkills），硬限制深度和条目数。
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
    const userDirs = settings.userSkillDirs ?? [];
    const disabledSkills = settings.disabledSkills ?? [];

    // 去重：内置目录优先
    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];

    for (const dir of [this.builtinDir, ...userDirs]) {
      for (const skill of scanSkillsDir(dir)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          allSkills.push(skill);
        }
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
    const dirs = settings.userSkillDirs ?? [];
    if (!dirs.includes(path)) {
      dirs.push(path);
      settings.userSkillDirs = dirs;
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
    const dirs = settings.userSkillDirs ?? [];
    if (!dirs.includes(path)) return;
    settings.userSkillDirs = dirs.filter(d => d !== path);
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
