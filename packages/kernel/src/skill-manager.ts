import { readFile, writeFile, mkdir, opendir, stat } from "node:fs/promises";
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
/** 单个技能目录扫描超时（毫秒） */
const SKILL_SCAN_TIMEOUT_MS = 8_000;
/** 添加目录时快速验证超时（毫秒） */
const ADD_DIR_TIMEOUT_MS = 3_000;
/** 添加目录时快速验证最多访问条目数 */
const ADD_DIR_VALIDATION_MAX_ENTRIES = 1_000;
/** 非技能目录判定阈值：验证完该数量条目仍未找到 SKILL.md 则拒绝 */
const ADD_DIR_NON_SKILL_THRESHOLD = 30;

/** 扫描时跳过的常见大目录/构建产物目录 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".idea",
  ".vscode",
  "Pods",
  ".gradle",
  ".svelte-kit",
  ".nuxt",
  ".output",
]);

class ScanTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, context?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new ScanTimeoutError(context ?? `操作超时（${ms}ms）`));
      }, ms);
    }),
  ]);
}

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
 * 轻量异步递归扫描指定目录，查找 SKILL.md 并解析 frontmatter。
 * 使用 fs/promises 避免阻塞事件循环，硬限制深度、条目数和超时，
 * 即使几万递归文件的目录也不会让 kernel 卡死。
 */
async function scanSkillsDir(dir: string): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  let totalEntries = 0;

  async function walk(currentDir: string, depth: number) {
    if (depth > MAX_DEPTH || totalEntries >= MAX_TOTAL_ENTRIES) return;

    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(currentDir);
    } catch {
      return;
    }

    try {
      let inspected = 0;
      for await (const entry of handle) {
        if (totalEntries >= MAX_TOTAL_ENTRIES) break;

        inspected++;
        if (inspected > MAX_PER_DIR) break;

        totalEntries++;

        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (EXCLUDED_DIRS.has(name)) continue;
        if (!entry.isDirectory()) continue;

        const fullPath = join(currentDir, name);

        // 先检查当前目录下是否有 SKILL.md（一技能一目录模式）
        try {
          const content = await readFile(join(fullPath, "SKILL.md"), "utf8");
          const info = parseSkillFrontmatter(content);
          if (info) {
            skills.push(info);
            continue; // 找到 SKILL.md 就不递归进入该目录
          }
        } catch {
          // 没有 SKILL.md，继续递归
        }

        await walk(fullPath, depth + 1);
      }
    } catch {
      // 目录在扫描过程中被删除或权限变化，直接跳过
    } finally {
      try {
        await handle.close();
      } catch {
        // 关闭句柄失败不影响结果
      }
    }
  }

  await walk(dir, 1);
  return skills;
}

/**
 * 快速判断一个目录是否像技能目录（自身或子目录包含 SKILL.md）。
 * 返回找到状态以及已检查的条目数，用于 addDir 时拒绝明显非技能的超大目录。
 */
async function hasSkillMd(dir: string): Promise<{ found: boolean; inspectedCount: number }> {
  let found = false;
  let inspectedCount = 0;

  // 先检查目录本身是否就是技能目录
  try {
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    if (parseSkillFrontmatter(content)) {
      return { found: true, inspectedCount: 0 };
    }
  } catch {
    // 不是单技能目录，继续检查子目录
  }

  async function walk(currentDir: string, depth: number) {
    if (found) return;
    if (depth > MAX_DEPTH) return;
    if (inspectedCount >= ADD_DIR_VALIDATION_MAX_ENTRIES) return;

    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(currentDir);
    } catch {
      return;
    }

    try {
      let inspectedInDir = 0;
      for await (const entry of handle) {
        if (found) break;
        if (inspectedCount >= ADD_DIR_VALIDATION_MAX_ENTRIES) break;

        inspectedInDir++;
        if (inspectedInDir > MAX_PER_DIR) break;

        inspectedCount++;

        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (EXCLUDED_DIRS.has(name)) continue;
        if (!entry.isDirectory()) continue;

        const fullPath = join(currentDir, name);

        try {
          const content = await readFile(join(fullPath, "SKILL.md"), "utf8");
          if (parseSkillFrontmatter(content)) {
            found = true;
            break;
          }
        } catch {
          // 该子目录不是技能目录，继续递归
        }

        await walk(fullPath, depth + 1);
      }
    } catch {
      // 扫描过程中权限变化等，安全跳过
    } finally {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }

  await walk(dir, 1);
  return { found, inspectedCount };
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
   * 扫描顺序：内置目录优先，然后 settings.skills 中的用户目录。
   * 单个目录扫描超时时会跳过该目录并记录错误，避免一个坏目录拖垮整个 kernel。
   */
  async scan(): Promise<ScanResult> {
    const settings = await this.readSettings();
    const userDirs = settings.userSkillDirs ?? [];
    const disabledSkills = settings.disabledSkills ?? [];

    // 去重：内置目录优先
    const seen = new Set<string>();
    const allSkills: SkillInfo[] = [];

    for (const dir of [this.builtinDir, ...userDirs]) {
      try {
        const list = await withTimeout(
          scanSkillsDir(dir),
          SKILL_SCAN_TIMEOUT_MS,
          `扫描目录超时: ${dir}`,
        );
        for (const skill of list) {
          if (!seen.has(skill.name)) {
            seen.add(skill.name);
            allSkills.push(skill);
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[skill-manager] 扫描目录失败或超时，已跳过: ${dir} (${reason})`);
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
