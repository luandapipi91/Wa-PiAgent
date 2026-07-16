import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkillInfo, SkillSource } from "@hiagent/shared";
import {
  withTimeout, hasSkillMd, scanSkillsDir,
  SKILL_SCAN_TIMEOUT_MS, ADD_DIR_TIMEOUT_MS, ADD_DIR_NON_SKILL_THRESHOLD,
  ScanTimeoutError,
} from "./skill-utils";

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

/**
 * 技能管理器：扫描/去重/目录管理/启用禁用。
 * 数据持久化在 dataDir/settings.json 的 skills / disabledSkills 字段。
 * 使用自实现轻量异步递归扫描（不依赖 Pi SDK loadSkills），硬限制深度、条目数和超时。
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
   * @param extensionSkillPaths 扩展包技能路径列表（由 extension-manager.getEnabledExtensionSkillPaths 提供）
   */
  async scan(
    extensionSkillPaths: { path: string; packageName: string }[] = [],
  ): Promise<ScanResult> {
    const settings = await this.readSettings();
    const userDirs = settings.userSkillDirs ?? [];
    const disabledSkills = settings.disabledSkills ?? [];

    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];

    // 内置目录
    try {
      const list = await withTimeout(
        scanSkillsDir(this.builtinDir, { type: "builtin" }),
        SKILL_SCAN_TIMEOUT_MS,
        `扫描目录超时: ${this.builtinDir}`,
      );
      for (const skill of list) {
        if (!seen.has(skill.name)) { seen.add(skill.name); allSkills.push(skill); }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[skill-manager] 扫描目录失败或超时，已跳过: ${this.builtinDir} (${reason})`);
    }

    // 用户目录
    for (const dir of userDirs) {
      try {
        const list = await withTimeout(
          scanSkillsDir(dir, { type: "user" }),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描目录超时: ${dir}`,
        );
        for (const skill of list) {
          if (!seen.has(skill.name)) { seen.add(skill.name); allSkills.push(skill); }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[skill-manager] 扫描目录失败或超时，已跳过: ${dir} (${reason})`);
      }
    }

    // 扩展技能目录
    for (const ext of extensionSkillPaths) {
      try {
        const list = await withTimeout(
          scanSkillsDir(ext.path, { type: "extension", name: ext.packageName }),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描扩展技能目录超时: ${ext.path}`,
        );
        for (const skill of list) {
          if (!seen.has(skill.name)) { seen.add(skill.name); allSkills.push(skill); }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[skill-manager] 扫描扩展技能目录失败或超时，已跳过: ${ext.path} (${reason})`);
      }
    }

    // 过滤禁用技能
    const skills = allSkills.filter(s => !disabledSkills.includes(s.name));
    const dirs = [this.builtinDir, ...userDirs];

    return { skills, allSkills, dirs, disabledSkills, builtinDir: this.builtinDir };
  }

  /**
   * 添加用户技能目录。
   * @throws 目录不存在/不是目录时抛出对应错误
   * @throws 路径为内置目录时抛出 "内置目录无需重复添加"
   * @throws 未检测到 SKILL.md 且目录明显非技能目录时抛出提示
   */
  async addDir(path: string): Promise<void> {
    let st;
    try {
      st = await stat(path);
    } catch {
      throw new Error("目录不存在");
    }
    if (!st.isDirectory()) throw new Error("路径不是目录");
    if (path === this.builtinDir) throw new Error("内置目录无需重复添加");

    // 快速验证：防止用户误选 /Library 之类的超大目录导致后续扫描负担
    const check = await withTimeout(
      hasSkillMd(path),
      ADD_DIR_TIMEOUT_MS,
      "目录验证超时",
    ).catch((err) => {
      if (err instanceof ScanTimeoutError) {
        throw new Error("目录验证超时，请检查目录是否过大");
      }
      throw err;
    });

    if (!check.found && check.inspectedCount > ADD_DIR_NON_SKILL_THRESHOLD) {
      throw new Error("未检测到 SKILL.md，请选择一个技能目录或包含技能目录的父目录");
    }

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
