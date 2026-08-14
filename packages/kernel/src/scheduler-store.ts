import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScheduledTask, ExecutionRecord } from "@wa-pi/shared";

// 数据持久化层：参照 channel-store.ts 的 readJson/writeJson 模式。
// 文件缺失/损坏均回退空值不抛错；写入带 schemaVersion 便于将来迁移。

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return fallback; // 文件不存在/损坏 → 回退，不抛错
	}
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function loadScheduledTasks(
	file: string,
): Promise<ScheduledTask[]> {
	const raw = await readJson<{ tasks?: ScheduledTask[] }>(file, {});
	return Array.isArray(raw.tasks) ? raw.tasks : [];
}

export async function saveScheduledTasks(
	file: string,
	tasks: ScheduledTask[],
): Promise<void> {
	await writeJson(file, { schemaVersion: 1, tasks });
}

export async function loadExecutionRecords(
	file: string,
): Promise<ExecutionRecord[]> {
	const raw = await readJson<{ records?: ExecutionRecord[] }>(file, {});
	return Array.isArray(raw.records) ? raw.records : [];
}

export async function saveExecutionRecords(
	file: string,
	records: ExecutionRecord[],
): Promise<void> {
	await writeJson(file, { schemaVersion: 1, records });
}

export async function appendExecutionRecord(
	file: string,
	record: ExecutionRecord,
): Promise<void> {
	const existing = await loadExecutionRecords(file);
	existing.push(record);
	await saveExecutionRecords(file, existing);
}
