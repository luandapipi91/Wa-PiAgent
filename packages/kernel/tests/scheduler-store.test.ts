import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadScheduledTasks,
	saveScheduledTasks,
	loadExecutionRecords,
	saveExecutionRecords,
	appendExecutionRecord,
} from "../src/scheduler-store";
import type { ScheduledTask, ExecutionRecord } from "@wa-pi/shared";

describe("scheduler-store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wa-pi-sched-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loadScheduledTasks：文件不存在 → 空数组", async () => {
		const tasks = await loadScheduledTasks(join(dir, "tasks.json"));
		expect(tasks).toEqual([]);
	});

	test("saveScheduledTasks/loadScheduledTasks：往返一致", async () => {
		const tasks: ScheduledTask[] = [
			{
				id: "task-1",
				name: "测试任务",
				schedule: { type: "daily", time: "09:30" },
				agentId: "agent-1",
				prompt: "你好",
				enabled: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		];
		await saveScheduledTasks(join(dir, "tasks.json"), tasks);
		const loaded = await loadScheduledTasks(join(dir, "tasks.json"));
		expect(loaded).toHaveLength(1);
		expect(loaded[0].name).toBe("测试任务");
	});

	test("appendExecutionRecord：逐条追加到现有记录", async () => {
		const file = join(dir, "records.json");
		const record: ExecutionRecord = {
			id: "rec-1",
			taskId: "task-1",
			taskName: "测试任务",
			status: "success",
			startedAt: Date.now(),
			finishedAt: Date.now(),
			durationMs: 5000,
		};
		await appendExecutionRecord(file, record);
		const loaded = await loadExecutionRecords(file);
		expect(loaded).toHaveLength(1);

		// 追加第二条
		const record2 = { ...record, id: "rec-2" };
		await appendExecutionRecord(file, record2);
		const loaded2 = await loadExecutionRecords(file);
		expect(loaded2).toHaveLength(2);
	});

	test("saveExecutionRecords/loadExecutionRecords：往返一致", async () => {
		const file = join(dir, "records.json");
		const records: ExecutionRecord[] = [
			{
				id: "rec-a",
				taskId: "task-1",
				taskName: "日报",
				status: "success",
				startedAt: 1000,
				finishedAt: 2000,
				durationMs: 1000,
			},
		];
		await saveExecutionRecords(file, records);
		const loaded = await loadExecutionRecords(file);
		expect(loaded).toEqual(records);
	});
});
