import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	toCronExpression,
	TaskScheduler,
	type SchedulerDeps,
} from "../src/scheduler";
import { saveScheduledTasks } from "../src/scheduler-store";
import type {
	ScheduledTask,
	ExecutionRecord,
	TaskSchedule,
} from "@wa-pi/shared";

// ===== 简报约定的 toCronExpression 用例（契约测试，原样保留）=====

describe("toCronExpression", () => {
	test("daily at 09:30", () => {
		const s: TaskSchedule = { type: "daily", time: "09:30" };
		expect(toCronExpression(s)).toBe("30 9 * * *");
	});

	test("weekdays at 18:00", () => {
		const s: TaskSchedule = { type: "weekdays", time: "18:00" };
		expect(toCronExpression(s)).toBe("0 18 * * 1-5");
	});

	test("weekly on Monday (dayOfWeek=1) at 10:00", () => {
		const s: TaskSchedule = { type: "weekly", time: "10:00", dayOfWeek: 1 };
		expect(toCronExpression(s)).toBe("0 10 * * 1");
	});

	test("monthly on 15th at 09:00", () => {
		const s: TaskSchedule = { type: "monthly", time: "09:00", dayOfMonth: 15 };
		expect(toCronExpression(s)).toBe("0 9 15 * *");
	});

	test("custom cron expression passthrough", () => {
		const s: TaskSchedule = {
			type: "custom",
			time: "00:00",
			cronExpression: "*/15 * * * *",
		};
		expect(toCronExpression(s)).toBe("*/15 * * * *");
	});
});

// ===== TaskScheduler 接线单测（桩 Bun.cron，无需真实计时）=====

/** 构造一个 ScheduledTask，默认 enabled daily 09:30。 */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		id: "t1",
		name: "测试任务",
		schedule: { type: "daily", time: "09:30" },
		agentId: "agent-1",
		prompt: "你好",
		enabled: true,
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

/** 构造 SchedulerDeps，broadcast/executeTask 默认空实现。 */
function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
	return {
		tasksFile: "/tmp/wa-pi-unused-tasks.json",
		recordsFile: "/tmp/wa-pi-unused-records.json",
		dataDir: "/tmp",
		executeTask: async () => ({
			id: "rec-1",
			taskId: "t1",
			taskName: "测试任务",
			status: "success",
			startedAt: 1,
		}),
		broadcast: () => {},
		...overrides,
	};
}

/** 桩 Bun.cron：记录每次调用的表达式与 handler，返回带 stop mock 的伪 job。 */
interface CronStub {
	cronCalls: { expr: string; handler: () => unknown }[];
	fakeJobs: { stop: ReturnType<typeof mock> }[];
	restore: () => void;
}
function stubCron(): CronStub {
	const original = Bun.cron;
	const cronCalls: CronStub["cronCalls"] = [];
	const fakeJobs: CronStub["fakeJobs"] = [];
	// Bun.cron 在类型上是只读的，这里一次性 cast 为可写引用供桩替换/还原。
	const mutableBun = Bun as unknown as { cron: typeof Bun.cron };
	mutableBun.cron = ((expr: string, handler: () => unknown) => {
		const stop = mock(() => {});
		cronCalls.push({ expr, handler });
		fakeJobs.push({ stop });
		return { stop };
	}) as unknown as typeof Bun.cron;
	return {
		cronCalls,
		fakeJobs,
		restore: () => void (mutableBun.cron = original),
	};
}

describe("TaskScheduler", () => {
	test("scheduleTask: enabled 任务 → 用转换后的 cron 表达式注册 job", () => {
		const { cronCalls, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps());
			scheduler.scheduleTask(
				makeTask({ schedule: { type: "weekdays", time: "18:00" } }),
			);
			expect(cronCalls).toHaveLength(1);
			expect(cronCalls[0].expr).toBe("0 18 * * 1-5");
		} finally {
			restore();
		}
	});

	test("scheduleTask: disabled 任务 → 不注册 job", () => {
		const { cronCalls, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps());
			scheduler.scheduleTask(makeTask({ enabled: false }));
			expect(cronCalls).toHaveLength(0);
		} finally {
			restore();
		}
	});

	test("handler 触发 → 调用 executeTask 并广播 completed 事件", async () => {
		const { cronCalls, restore } = stubCron();
		const broadcasts: { type: string; [k: string]: unknown }[] = [];
		const record: ExecutionRecord = {
			id: "rec-1",
			taskId: "t1",
			taskName: "测试任务",
			status: "success",
			startedAt: 1,
		};
		const executeTask = mock(async () => record);
		try {
			const scheduler = new TaskScheduler(
				makeDeps({
					executeTask,
					broadcast: (e) => void broadcasts.push(e),
				}),
			);
			scheduler.scheduleTask(makeTask());
			expect(cronCalls).toHaveLength(1);
			await cronCalls[0].handler();
			expect(executeTask).toHaveBeenCalledTimes(1);
			expect(broadcasts).toHaveLength(1);
			expect(broadcasts[0]).toMatchObject({
				type: "scheduled-task:completed",
				taskId: "t1",
				recordId: "rec-1",
				status: "success",
			});
		} finally {
			restore();
		}
	});

	test("handler 执行抛错 → 广播 failed 事件（含 error 文案）", async () => {
		const { cronCalls, restore } = stubCron();
		const broadcasts: { type: string; [k: string]: unknown }[] = [];
		const executeTask = mock(async () => {
			throw new Error("boom");
		});
		try {
			const scheduler = new TaskScheduler(
				makeDeps({
					executeTask,
					broadcast: (e) => void broadcasts.push(e),
				}),
			);
			scheduler.scheduleTask(makeTask());
			await cronCalls[0].handler();
			expect(broadcasts).toHaveLength(1);
			expect(broadcasts[0]).toMatchObject({
				type: "scheduled-task:completed",
				taskId: "t1",
				status: "failed",
			});
			expect(broadcasts[0].error).toBe("Error: boom");
		} finally {
			restore();
		}
	});

	test("cancelTask → 调用已注册 job 的 stop()", () => {
		const { fakeJobs, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps());
			scheduler.scheduleTask(makeTask());
			scheduler.cancelTask("t1");
			expect(fakeJobs[0].stop).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	test("cancelTask: 未注册的 id → 静默无操作", () => {
		const { fakeJobs, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps());
			scheduler.scheduleTask(makeTask());
			// 取消一个不存在的任务不应影响已注册任务
			expect(() => scheduler.cancelTask("nonexistent")).not.toThrow();
			expect(fakeJobs[0].stop).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	test("重新调度同一 id → 先 stop 旧 job 再注册新 job", () => {
		const { cronCalls, fakeJobs, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps());
			scheduler.scheduleTask(makeTask({ id: "t1" }));
			scheduler.scheduleTask(
				makeTask({
					id: "t1",
					schedule: { type: "monthly", time: "09:00", dayOfMonth: 15 },
				}),
			);
			expect(cronCalls).toHaveLength(2);
			expect(cronCalls[1].expr).toBe("0 9 15 * *"); // 新表达式生效
			expect(fakeJobs[0].stop).toHaveBeenCalledTimes(1); // 旧 job 被停止
		} finally {
			restore();
		}
	});

	test("stopAll → 停止所有已注册 job", () => {
		const { fakeJobs, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps());
			scheduler.scheduleTask(makeTask({ id: "a" }));
			scheduler.scheduleTask(makeTask({ id: "b" }));
			scheduler.stopAll();
			expect(fakeJobs[0].stop).toHaveBeenCalledTimes(1);
			expect(fakeJobs[1].stop).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	test("start: 从持久化文件加载，仅注册 enabled 任务", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wa-pi-sched-"));
		const tasksFile = join(dir, "tasks.json");
		const tasks: ScheduledTask[] = [
			makeTask({ id: "on", enabled: true }),
			makeTask({ id: "off", enabled: false }),
		];
		await saveScheduledTasks(tasksFile, tasks);
		const { cronCalls, restore } = stubCron();
		try {
			const scheduler = new TaskScheduler(makeDeps({ tasksFile }));
			await scheduler.start();
			expect(cronCalls).toHaveLength(1); // 仅 enabled
			expect(cronCalls[0].expr).toBe("30 9 * * *");
		} finally {
			restore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("start: 某任务注册失败（cron 抛错）→ 广播 error，其余任务仍正常注册", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wa-pi-sched-"));
		const tasksFile = join(dir, "tasks.json");
		const tasks: ScheduledTask[] = [
			makeTask({
				id: "bad",
				schedule: {
					type: "custom",
					time: "00:00",
					cronExpression: "bad-expr",
				},
			}),
			makeTask({ id: "good", schedule: { type: "daily", time: "09:30" } }),
		];
		await saveScheduledTasks(tasksFile, tasks);
		const broadcasts: { type: string; [k: string]: unknown }[] = [];
		// 桩 Bun.cron：对非法表达式同步抛错，模拟格式错误的 custom 任务
		const original = Bun.cron;
		const cronCalls: { expr: string }[] = [];
		const mutableBun = Bun as unknown as { cron: typeof Bun.cron };
		mutableBun.cron = ((expr: string) => {
			cronCalls.push({ expr });
			if (expr === "bad-expr") {
				throw new Error("invalid cron expression");
			}
			return { stop: mock(() => {}) };
		}) as unknown as typeof Bun.cron;
		try {
			const scheduler = new TaskScheduler(
				makeDeps({ tasksFile, broadcast: (e) => void broadcasts.push(e) }),
			);
			await scheduler.start();
			// 两个 enabled 任务都被尝试调用 Bun.cron
			expect(cronCalls).toHaveLength(2);
			// bad 任务广播了 error 事件
			expect(broadcasts).toContainEqual(
				expect.objectContaining({
					type: "scheduled-task:error",
					taskId: "bad",
					error: expect.stringContaining("invalid cron"),
				}),
			);
			// good 任务不受影响，仍被注册
			expect(cronCalls[1].expr).toBe("30 9 * * *");
		} finally {
			mutableBun.cron = original;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
