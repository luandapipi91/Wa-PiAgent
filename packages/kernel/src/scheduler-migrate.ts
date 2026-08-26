/**
 * 旧定时任务 JSON（~/.pi/agent/scheduled-tasks.json + execution-records.json）
 * 到项目文件夹格式的一次性迁移。
 *
 * - 任务按 projectId 分发到对应项目 tasks/；无 projectId 进默认工作区
 * - 新 id = sanitizeTaskId(name)（冲突追加 -2）；执行记录 taskId 同步改写为新 id
 * - 完成后旧文件重命名为 .migrated 归档（不删除，可人工回查）
 * - 幂等：旧文件不存在即 no-op
 */
import { mkdir, rename, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionRecord, ScheduledTask } from "@wa-pi/shared";
import { formatLogLine, sanitizeTaskId, serializeTaskFile } from "@wa-pi/shared";
import { tasksDirOf, logsDirOf } from "./scheduler-task-store";

// 旧 JSON 读取（替代已删除的旧存储层读函数）：文件缺失/损坏均回退空数组不抛错。
// loadScheduledTasks(file) → readJsonArray<ScheduledTask>(file, "tasks")
// loadExecutionRecords(file) → readJsonArray<ExecutionRecord>(file, "records")
async function readJsonArray<T>(file: string, key: string): Promise<T[]> {
	try {
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, T[]>;
		return Array.isArray(raw[key]) ? raw[key] : [];
	} catch {
		return [];
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

export async function migrateLegacySchedulerFiles(deps: {
	legacyTasksFile: string;
	legacyRecordsFile: string;
	resolveProject: (projectId?: string) => { id: string; cwd: string };
}): Promise<{ migrated: number }> {
	if (!(await exists(deps.legacyTasksFile))) return { migrated: 0 };
	const legacyTasks = await readJsonArray<ScheduledTask>(deps.legacyTasksFile, "tasks");
	const legacyRecords = (await exists(deps.legacyRecordsFile))
		? await readJsonArray<ExecutionRecord>(deps.legacyRecordsFile, "records")
		: [];

	// 旧 id → 新 id（执行记录改写用）
	const idMap = new Map<string, { newId: string; projectId: string; cwd: string }>();
	let migrated = 0;
	for (const task of legacyTasks) {
		const project = deps.resolveProject(task.projectId);
		const dir = tasksDirOf(project.cwd);
		await mkdir(dir, { recursive: true });
		const base = sanitizeTaskId(task.name);
		let newId = base;
		for (let i = 2; await exists(join(dir, `${newId}.md`)); i++) newId = `${base}-${i}`;
		const content = serializeTaskFile(
			{
				name: task.name,
				schedule: task.schedule,
				agentId: task.agentId,
				model: typeof task.model === "string" ? task.model : undefined,
				enabled: task.enabled,
			},
			task.prompt,
		);
		const file = join(dir, `${newId}.md`);
		const tmp = `${file}.tmp-${process.pid}`;
		await writeFile(tmp, content, "utf8");
		await rename(tmp, file);
		idMap.set(task.id, { newId, projectId: project.id, cwd: project.cwd });
		migrated++;
	}

	// 执行记录按任务归属追加到新 log（taskId 改写为新 id；孤儿记录丢弃）
	const byTask = new Map<string, ExecutionRecord[]>();
	for (const rec of legacyRecords) {
		const mapped = idMap.get(rec.taskId);
		if (!mapped) continue;
		const list = byTask.get(rec.taskId) ?? [];
		list.push({ ...rec, taskId: mapped.newId });
		byTask.set(rec.taskId, list);
	}
	for (const [oldId, records] of byTask) {
		const mapped = idMap.get(oldId)!;
		const dir = logsDirOf(mapped.cwd);
		await mkdir(dir, { recursive: true });
		const lines = records.map((r) => formatLogLine(r)).join("\n");
		await writeFile(join(dir, `${mapped.newId}.log`), `${lines}\n`, { flag: "a" });
	}

	await rename(deps.legacyTasksFile, `${deps.legacyTasksFile}.migrated`);
	if (await exists(deps.legacyRecordsFile)) {
		await rename(deps.legacyRecordsFile, `${deps.legacyRecordsFile}.migrated`);
	}
	return { migrated };
}
