/**
 * 预设智能体生成脚本：扫描 docs/references/agency-agents-zh/ 的 19 个部门目录，
 * 解析每个 md 的 YAML frontmatter（name/description/emoji/color）+ 正文，
 * 输出 packages/kernel/src/data/agency-presets.json（AgencyPreset[]，提交入库）。
 *
 * 用法：bun scripts/generate-agency-presets.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { AGENCY_DEPARTMENTS, type AgencyPreset } from "@wa-pi/shared";

const SOURCE_DIR = join(import.meta.dir, "..", "docs", "references", "agency-agents-zh");
const OUT_FILE = join(import.meta.dir, "..", "packages", "kernel", "src", "data", "agency-presets.json");

export interface ParsedAgencyMd {
  name: string;
  description: string;
  emoji: string;
  color: string;
  body: string;
}

/** 解析 agency md：frontmatter 缺 name/description 或无 frontmatter 返回 null */
export function parseAgencyMd(md: string): ParsedAgencyMd | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    // 剥掉首尾引号（color: "#06B6D4" 这种写法）
    fields[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  if (!fields.name || !fields.description) return null;
  return {
    name: fields.name,
    description: fields.description,
    emoji: fields.emoji ?? "",
    color: fields.color ?? "",
    body: m[2].trim(),
  };
}

/** 递归收集目录下所有 .md 文件 */
function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

function main() {
  const presets: AgencyPreset[] = [];
  const seenIds = new Set<string>();
  for (const [dir, department] of Object.entries(AGENCY_DEPARTMENTS)) {
    const absDir = join(SOURCE_DIR, dir);
    for (const file of walkMd(absDir)) {
      const parsed = parseAgencyMd(readFileSync(file, "utf8"));
      if (!parsed) continue; // 索引文档/示例文件自然落空
      const id = basename(file, ".md");
      if (seenIds.has(id)) {
        console.warn(`跳过重复 id: ${id}（${relative(SOURCE_DIR, file)}）`);
        continue;
      }
      seenIds.add(id);
      presets.push({ id, department, ...parsed });
    }
  }
  presets.sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(join(OUT_FILE, ".."), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(presets), "utf8");
  console.log(`已生成 ${presets.length} 条预设 → ${relative(process.cwd(), OUT_FILE)}`);
  if (presets.length !== 268) {
    console.warn(`警告：预期 268 条，实际 ${presets.length} 条（agency-agents-zh 可能已更新）`);
  }
}

// 被测试 import 时不执行 main
if (import.meta.main) main();
