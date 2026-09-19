import { readFile, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillInfo, SkillSource } from "@wa-pi/shared";

/** 递归扫描最大深度（skill-dir / skill-name / SKILL.md = 3 层） */
export const MAX_DEPTH = 3;
/** 单层目录最多遍历条目数 */
export const MAX_PER_DIR = 200;
/** 全量扫描最多访问的条目总数 */
export const MAX_TOTAL_ENTRIES = 5000;
/** 单个技能目录扫描超时（毫秒） */
export const SKILL_SCAN_TIMEOUT_MS = 8_000;
/** 添加目录时快速验证超时（毫秒） */
export const ADD_DIR_TIMEOUT_MS = 3_000;
/** 添加目录时快速验证最多访问条目数 */
export const ADD_DIR_VALIDATION_MAX_ENTRIES = 1_000;
/** 非技能目录判定阈值：验证完该数量条目仍未找到 SKILL.md 则拒绝 */
export const ADD_DIR_NON_SKILL_THRESHOLD = 30;

/** 扫描时跳过的常见大目录/构建产物目录 */
export const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  "vendor", ".venv", "__pycache__", ".cache", ".turbo", ".idea", ".vscode",
  "Pods", ".gradle", ".svelte-kit", ".nuxt", ".output",
]);

export class ScanTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, context?: string): Promise<T> {
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
 */
export function parseSkillFrontmatter(content: string, dir: string): SkillInfo | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const descValue = fm.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim();
  if (!name) return null;
  let description = descValue ?? "";
  // YAML 块标量（description: | 或 >，可带 +/-）：值为后续缩进行，拼成单行
  if (description && /^[|>][+-]?$/.test(description)) {
    const lines = fm.split("\n");
    const start = lines.findIndex(l => /^description:/.test(l));
    const collected: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s+\S/.test(l)) collected.push(l.trim());
      else if (l.trim() === "") { if (collected.length) break; }
      else break;
    }
    description = collected.join(" ").trim();
  }
  return { name, description, path: dir };
}

/**
 * 轻量异步递归扫描指定目录，查找 SKILL.md 并解析 frontmatter。
 * @param source 可选来源标记，写入每个 SkillInfo.source
 */
export async function scanSkillsDir(
  dir: string,
  source?: SkillSource,
): Promise<SkillInfo[]> {
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
        try {
          const content = await readFile(join(fullPath, "SKILL.md"), "utf8");
          const info = parseSkillFrontmatter(content, fullPath);
          if (info) {
            if (source) info.source = source;
            skills.push(info);
            continue;
          }
        } catch {
          // 没有 SKILL.md，继续递归
        }
        await walk(fullPath, depth + 1);
      }
    } catch {
      // 目录在扫描过程中被删除或权限变化，直接跳过
    } finally {
      try { await handle.close(); } catch {}
    }
  }

  await walk(dir, 1);
  return skills;
}

/**
 * 快速判断一个目录是否像技能目录（自身或子目录包含 SKILL.md）。
 */
export async function hasSkillMd(dir: string): Promise<{ found: boolean; inspectedCount: number }> {
  let found = false;
  let inspectedCount = 0;

  try {
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    if (parseSkillFrontmatter(content, dir)) {
      return { found: true, inspectedCount: 0 };
    }
  } catch {}

  async function walk(currentDir: string, depth: number) {
    if (found) return;
    if (depth > MAX_DEPTH) return;
    if (inspectedCount >= ADD_DIR_VALIDATION_MAX_ENTRIES) return;

    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try { handle = await opendir(currentDir); } catch { return; }

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
          if (parseSkillFrontmatter(content, fullPath)) { found = true; break; }
        } catch {}

        await walk(fullPath, depth + 1);
      }
    } catch {}
    finally { try { await handle.close(); } catch {} }
  }

  await walk(dir, 1);
  return { found, inspectedCount };
}
