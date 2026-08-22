// 老数据迁移：老用户首次启动新版（项目模型），无项目但有孤儿 session → 建默认项目并归入
import type { ProjectStore } from "./project-store";

/**
 * 迁移条件：projects.json 无项目，但 sessions 数组有记录（老版本平铺的会话）。
 * 这些 session 的 projectId 指向老版本不存在的项目 id → 建默认项目，reassign 归入。
 * 新用户（无项目无 session）不触发，走空态引导。
 */
export async function migrateLegacySessions(
  projectStore: ProjectStore,
): Promise<boolean> {
  const { projects, sessions } = await projectStore.load();

  // 已有项目 → 无需迁移（新用户或已迁移过的老用户）
  if (projects.length > 0) return false;

  // 无项目且无 session → 新用户，不强制建项目
  if (sessions.length === 0) return false;

  // 有孤儿 session → 建默认项目
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const defaultProject = await projectStore.createProject({
    name: "默认项目",
    cwd: home,
  });

  // 把所有孤儿 session 归入默认项目
  for (const s of sessions) {
    await projectStore.reassignSession(s.id, defaultProject.id);
  }
  return true;
}
