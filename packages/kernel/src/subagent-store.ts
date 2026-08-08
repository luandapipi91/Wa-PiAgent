import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SubagentOverride } from "@wa-pi/shared";
import { SUBAGENT_OVERRIDES_FILE } from "@wa-pi/shared";

interface OverrideFile {
  overrides: SubagentOverride[];
}

/** 从文件加载全部 subagent 覆盖记录。文件不存在返回空数组。 */
export async function loadSubagentOverrides(filePath: string = SUBAGENT_OVERRIDES_FILE): Promise<SubagentOverride[]> {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return [];
    const data: OverrideFile = JSON.parse(raw);
    return data.overrides ?? [];
  } catch {
    return [];
  }
}

/** 保存一条覆盖记录（同 type 覆盖已有，否则新增），返回全量。 */
export async function saveSubagentOverride(
  filePath: string,
  override: SubagentOverride,
): Promise<SubagentOverride[]> {
  const all = await loadSubagentOverrides(filePath);
  const idx = all.findIndex(o => o.type === override.type);
  if (idx >= 0) {
    all[idx] = override;
  } else {
    all.push(override);
  }
  writeFileSync(filePath, JSON.stringify({ overrides: all }, null, 2), "utf8");
  return all;
}

/** 获取单个 type 的覆盖记录，未找到返回 undefined。 */
export async function getSubagentOverride(
  filePath: string,
  type: string,
): Promise<SubagentOverride | undefined> {
  const all = await loadSubagentOverrides(filePath);
  return all.find(o => o.type === type);
}

/** 幂等初始化 overrides 文件（不存在则写入空数组）。失败不抛错，不阻塞启动。 */
export async function ensureSubagentOverrides(filePath: string = SUBAGENT_OVERRIDES_FILE): Promise<void> {
  try {
    if (!existsSync(filePath)) {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, JSON.stringify({ overrides: [] }, null, 2), "utf8");
    }
  } catch {
    // 不阻塞启动
  }
}
