import { rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectStore } from "./project-store";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD, WORKDIR_TTL_DAYS,
} from "@hiagent/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 扫描默认工作区根目录下的子目录，按三重规则清理过期目录：
 *
 * 1. 子目录名必须全数字（时间戳格式）
 * 2. 子目录路径不在当前 sessions 表的"被引用目录"集合中
 *    （被现存会话引用的目录不能删，即便超时）
 * 3. 子目录 mtime 距今超过 WORKDIR_TTL_DAYS 天
 *
 * @param projectStore 用于查询当前 sessions 表
 * @param root 可选，默认用 SYSTEM_PROJECT_CWD；测试可注入临时目录
 * @returns 实际清理的目录数
 */
export async function cleanupExpiredWorkdirs(
  projectStore: ProjectStore,
  root: string = SYSTEM_PROJECT_CWD,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;  // 根目录不存在
  }

  // 计算"被现存会话引用"的目录路径集合
  const { sessions } = await projectStore.load();
  const activeDirs = new Set<string>();
  for (const s of sessions) {
    if (s.projectId === SYSTEM_PROJECT_ID) {
      activeDirs.add(join(root, String(s.createdAt)));
    }
  }

  const now = Date.now();
  let cleaned = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;  // 非时间戳目录跳过
    const dirPath = join(root, name);
    if (activeDirs.has(dirPath)) continue;  // 被现存会话引用
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;  // stat 失败（可能是普通文件而非目录）跳过
    }
    if (!st.isDirectory()) continue;  // 只清目录，不动文件
    if (now - st.mtimeMs > WORKDIR_TTL_DAYS * DAY_MS) {
      try {
        await rm(dirPath, { recursive: true, force: true });
        cleaned++;
      } catch (e) {
        console.warn(`[workdir-cleaner] 删除失败: ${dirPath}`, e);
      }
    }
  }
  return cleaned;
}
