/**
 * 定时任务的项目列表组合：projectStore 全部项目 + 默认工作区。
 *
 * 默认工作区由 ensureSystemProject 在启动时 seed 进 projects.json，
 * 正常情况下已在列表中；这里仍兜底补一条（未 seed/被异常删除时），
 * 保证定时任务的「无项目」归属永远可用。
 */
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "@wa-pi/shared";
import type { ProjectRef } from "./scheduler-task-store";

export async function buildSchedulerProjects(
	listProjects: () => Promise<Array<{ id: string; cwd: string }>>,
): Promise<ProjectRef[]> {
	const projects = await listProjects();
	const result: ProjectRef[] = [];
	for (const p of projects) {
		if (result.some((x) => x.id === p.id)) continue; // id 去重
		result.push({ id: p.id, cwd: p.cwd });
	}
	if (!result.some((p) => p.id === SYSTEM_PROJECT_ID)) {
		result.unshift({ id: SYSTEM_PROJECT_ID, cwd: SYSTEM_PROJECT_CWD });
	}
	return result;
}
