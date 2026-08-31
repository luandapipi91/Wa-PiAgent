import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createFolderTaskStore,
	tasksDirOf,
	setScheduledTasksRoot,
} from "../src/scheduler-task-store";
import { TaskFolderWatcher } from "../src/scheduler-watcher";
import type { ScheduledTask, TaskFileError } from "@wa-pi/shared";

let dir: string;
let projA: string;
let watcher: TaskFolderWatcher | null = null;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-watcher-"));
	projA = join(dir, "proj-a");
	mkdirSync(projA, { recursive: true });
	// 全局根切到临时目录
	setScheduledTasksRoot(join(dir, "scheduled-tasks"));
	mkdirSync(tasksDirOf(), { recursive: true });
});

afterEach(() => {
	watcher?.stop();
	watcher = null;
	rmSync(dir, { recursive: true, force: true });
});

/** 等 applyTasks 被调用（watcher 有 300ms 防抖，轮询等待）；默认超时放宽到 10s，避免并行负载下 flaky */
async function waitFor(cond: () => boolean, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 50));
	}
}

const MD = `---\nname: "每日站会"\nschedule: {"type":"daily","time":"09:30"}\nagentId: "main"\nprojectId: "pa"\nenabled: true\n---\n\n提醒站会\n`;

describe("TaskFolderWatcher", () => {
	test("外部新增任务文件 → applyTasks 收到新任务", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const applied: ScheduledTask[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			applyTasks: (tasks) => applied.push(tasks),
		});
		await watcher.start();
		writeFileSync(join(tasksDirOf(), "每日站会.md"), MD);
		await waitFor(() =>
			applied.some((ts) => ts.some((t) => t.id === "每日站会")),
		);
	}, 15000);

	test("store 自身写入（同内容哈希）不触发 applyTasks", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const applied: ScheduledTask[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			applyTasks: (tasks) => applied.push(tasks),
		});
		await watcher.start();
		await store.create(
			{
				name: "每日站会",
				schedule: { type: "daily", time: "09:30" },
				agentId: "main",
				enabled: true,
				projectId: "pa",
				prompt: "提醒站会",
			},
			"pa",
		);
		// 等 1s（覆盖防抖窗口）：自写不应触发 applyTasks
		await new Promise((r) => setTimeout(r, 1000));
		expect(applied).toEqual([]);
	}, 15000);

	test("解析失败文件经 errors 传出；删除文件后任务消失", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const errorsSeen: TaskFileError[][] = [];
		const applied: ScheduledTask[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			applyTasks: (tasks, errors) => {
				applied.push(tasks);
				errorsSeen.push(errors);
			},
		});
		await watcher.start();
		const bad = join(tasksDirOf(), "坏任务.md");
		writeFileSync(bad, "没有 frontmatter");
		await waitFor(() =>
			errorsSeen.some((es) => es.some((e) => e.taskId === "坏任务")),
		);
		rmSync(bad, { force: true });
		await waitFor(() =>
			errorsSeen.some((es) => es.length === 0 && applied.length > 0),
		);
	}, 15000);

	test("自写有效任务 + 外部新增坏文件 → 不短路，applyTasks 仍被调用且 error 被广播", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const applied: ScheduledTask[][] = [];
		const errorsSeen: TaskFileError[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			applyTasks: (tasks, errors) => {
				applied.push(tasks);
				errorsSeen.push(errors);
			},
		});
		await watcher.start();
		// store 自写一个有效任务（记录自写哈希）
		await store.create(
			{
				name: "每日站会",
				schedule: { type: "daily", time: "09:30" },
				agentId: "main",
				enabled: true,
				projectId: "pa",
				prompt: "提醒站会",
			},
			"pa",
		);
		// 外部新增一个解析失败文件（非自写）
		writeFileSync(join(tasksDirOf(), "坏任务.md"), "没有 frontmatter");
		// 存在自写有效任务且 errors 非空：不得短路，applyTasks 需把 error 广播出去
		await waitFor(() =>
			errorsSeen.some((es) => es.some((e) => e.taskId === "坏任务")),
		);
		expect(applied.length).toBeGreaterThan(0);
	}, 15000);

	test("被 watch 的目录被外部删除后 watcher 不崩溃、stop 正常", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		watcher = new TaskFolderWatcher({
			store,
			applyTasks: () => {},
		});
		await watcher.start();
		// 外部直接删掉被 watch 的 tasks 目录：FSWatcher 会异步 emit 'error'，
		// 有 error 监听时不应进程崩溃
		rmSync(tasksDirOf(), { recursive: true, force: true });
		await new Promise((r) => setTimeout(r, 1000));
		// 进程无恙：watcher 仍可正常 stop（afterEach 还会再 stop 一次，幂等）
		expect(() => watcher?.stop()).not.toThrow();
	}, 15000);
});
