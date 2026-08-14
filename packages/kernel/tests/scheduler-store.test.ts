import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	loadScheduledTasks,
	saveScheduledTasks,
	loadExecutionRecords,
	saveExecutionRecords,
	appendExecutionRecord,
	updateExecutionRecord,
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

	test("loadScheduledTasks：文件损坏 → 空数组（不抛错）", async () => {
		const file = join(dir, "tasks.json");
		await writeFile(file, "}}invalid json{{", "utf8");
		const tasks = await loadScheduledTasks(file);
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

	test("loadExecutionRecords：文件损坏 → 空数组（不抛错）", async () => {
		const file = join(dir, "records.json");
		await writeFile(file, "}}invalid json{{", "utf8");
		const records = await loadExecutionRecords(file);
		expect(records).toEqual([]);
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

	// 复现审查发现 2：多任务 cron 指向同一时刻时并发 append，
	// 修复前 load→push→save 无锁互覆盖只剩 1 条；写队列串行化后全部保留。
	test("并发 appendExecutionRecord：串行化后记录不丢", async () => {
		const file = join(dir, "records.json");
		const base = {
			taskId: "task-1",
			taskName: "并发任务",
			status: "success" as const,
			startedAt: 0,
			finishedAt: 0,
			durationMs: 0,
		};
		const records: ExecutionRecord[] = Array.from({ length: 20 }, (_, i) => ({
			...base,
			id: `rec-${i}`,
		}));
		await Promise.all(records.map((r) => appendExecutionRecord(file, r)));
		const loaded = await loadExecutionRecords(file);
		expect(loaded).toHaveLength(20);
		expect(new Set(loaded.map((r) => r.id)).size).toBe(20);
	});

	// append（running 态落盘）与 update（终态回写）混发：任务并发执行时的真实模式
	test("append 与 update 混合并发：互不覆盖，终态正确回写", async () => {
		const file = join(dir, "records.json");
		const mk = (id: string): ExecutionRecord => ({
			id,
			taskId: "task-1",
			taskName: "混合并发",
			status: "running",
			startedAt: 0,
		});
		// 先串行落下两条 running 记录
		await appendExecutionRecord(file, mk("rec-a"));
		await appendExecutionRecord(file, mk("rec-b"));
		// 再并发：update rec-a 终态 + append rec-c + update 不存在的 rec-d（退化为追加）
		await Promise.all([
			updateExecutionRecord(file, {
				...mk("rec-a"),
				status: "success",
				finishedAt: 100,
				durationMs: 100,
			}),
			appendExecutionRecord(file, mk("rec-c")),
			updateExecutionRecord(file, mk("rec-d")),
		]);
		const loaded = await loadExecutionRecords(file);
		expect(loaded.map((r) => r.id).sort()).toEqual([
			"rec-a",
			"rec-b",
			"rec-c",
			"rec-d",
		]);
		expect(loaded.find((r) => r.id === "rec-a")?.status).toBe("success");
	});
});
