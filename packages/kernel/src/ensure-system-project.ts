import { mkdir } from "node:fs/promises";
import type { ProjectStore } from "./project-store";
import {
  SYSTEM_PROJECT_ID, SYSTEM_PROJECT_NAME, SYSTEM_PROJECT_CWD,
} from "@hiagent/shared";

/**
 * 启动时确保默认工作区虚拟项目存在（幂等）。
 *
 * - 若 projects.json 中无 SYSTEM_PROJECT_ID 记录 → 写入一条
 * - 始终确保 SYSTEM_PROJECT_CWD 根目录存在（~/.hiagent/workdir）
 *
 * 不抛错：失败仅 console.warn，不阻塞 kernel 启动。
 */
export async function ensureSystemProject(projectStore: ProjectStore): Promise<void> {
  try {
    await projectStore.createSystemProject({
      id: SYSTEM_PROJECT_ID,
      name: SYSTEM_PROJECT_NAME,
      cwd: SYSTEM_PROJECT_CWD,
    });
    await mkdir(SYSTEM_PROJECT_CWD, { recursive: true });
  } catch (e) {
    console.warn("[kernel] ensureSystemProject 失败:", e);
  }
}
