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

// 模块级写队列：所有文件写操作串行化。多个任务 cron 指向同一时刻时并发触发
// append/update，无锁的 load→push→save 会互相覆盖丢记录；统一经 promise 链排队。
// 注意：入队 op 内部不得再调用入队版函数（嵌套等待自身前置 → 死锁），
// 原子读-改-写内部直接用 writeJson。
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
	const result = writeChain.then(op);
	writeChain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export async function loadScheduledTasks(
	file: string,
): Promise<ScheduledTask[]> {
	const raw = await readJson<{ tasks?: ScheduledTask[] }>(file, {});
	return Array.isArray(raw.tasks) ? raw.tasks : [];
}

export function saveScheduledTasks(
	file: string,
	tasks: ScheduledTask[],
): Promise<void> {
	return enqueueWrite(() => writeJson(file, { schemaVersion: 1, tasks }));
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

export function appendExecutionRecord(
	file: string,
	record: ExecutionRecord,
): Promise<void> {
	// 整个读-改-写作为原子单元入队
	return enqueueWrite(async () => {
		const existing = await loadExecutionRecords(file);
		existing.push(record);
		await writeJson(file, { schemaVersion: 1, records: existing });
	});
}

/**
 * 按 id 更新已存在的执行记录（用于 running 态记录在任务完成后回写终态）。
 * 不存在时退化为追加，保证记录不丢。
 */
export function updateExecutionRecord(
	file: string,
	record: ExecutionRecord,
): Promise<void> {
	return enqueueWrite(async () => {
		const existing = await loadExecutionRecords(file);
		const idx = existing.findIndex((r) => r.id === record.id);
		if (idx >= 0) {
				existing[idx] = record;
		} else {
				existing.push(record);
		}
		await writeJson(file, { schemaVersion: 1, records: existing });
	});
}
