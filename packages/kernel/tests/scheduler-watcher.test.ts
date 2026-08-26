import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFolderTaskStore, tasksDirOf } from "../src/scheduler-task-store";
import { TaskFolderWatcher } from "../src/scheduler-watcher";
import type { ScheduledTask, TaskFileError } from "@wa-pi/shared";

let dir: string;
let projA: string;
let watcher: TaskFolderWatcher | null = null;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-watcher-"));
	projA = join(dir, "proj-a");
	mkdirSync(tasksDirOf(projA), { recursive: true });
});

afterEach(() => {
	watcher?.stop();
	watcher = null;
	rmSync(dir, { recursive: true, force: true });
});

/** 等 applyTasks 被调用（watcher 有 300ms 防抖，轮询等待） */
async function waitFor(
	cond: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 50));
	}
}

const MD = `---\nname: "每日站会"\nschedule: {"type":"daily","time":"09:30"}\nagentId: "main"\nenabled: true\n---\n\n提醒站会\n`;

describe("TaskFolderWatcher", () => {
	test("外部新增任务文件 → applyTasks 收到新任务", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const applied: ScheduledTask[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
			applyTasks: (tasks) => applied.push(tasks),
		});
		await watcher.start();
		writeFileSync(join(tasksDirOf(projA), "每日站会.md"), MD);
		await waitFor(() => applied.some((ts) => ts.some((t) => t.id === "每日站会")));
	});

	test("store 自身写入（同内容哈希）不触发 applyTasks", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const applied: ScheduledTask[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
			applyTasks: (tasks) => applied.push(tasks),
		});
		await watcher.start();
		await store.create(
			{
				name: "每日站会",
				schedule: { type: "daily", time: "09:30" },
				agentId: "main",
				enabled: true,
				prompt: "提醒站会",
			},
			"pa",
		);
		// 等 1s（覆盖防抖窗口）：自写不应触发 applyTasks
		await new Promise((r) => setTimeout(r, 1000));
		expect(applied).toEqual([]);
	});

	test("解析失败文件经 errors 传出；删除文件后任务消失", async () => {
		const store = createFolderTaskStore({
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
		});
		const errorsSeen: TaskFileError[][] = [];
		const applied: ScheduledTask[][] = [];
		watcher = new TaskFolderWatcher({
			store,
			projectsProvider: () => Promise.resolve([{ id: "pa", cwd: projA }]),
			applyTasks: (tasks, errors) => {
				applied.push(tasks);
				errorsSeen.push(errors);
			},
		});
		await watcher.start();
		const bad = join(tasksDirOf(projA), "坏任务.md");
		writeFileSync(bad, "没有 frontmatter");
		await waitFor(() => errorsSeen.some((es) => es.some((e) => e.taskId === "坏任务")));
		rmSync(bad, { force: true });
		await waitFor(() =>
			errorsSeen.some((es) => es.length === 0 && applied.length > 0),
		);
	});
});
