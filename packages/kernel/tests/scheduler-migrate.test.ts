import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacySchedulerFiles } from "../src/scheduler-migrate";
import { tasksDirOf, logsDirOf } from "../src/scheduler-task-store";
import { parseTaskFile, parseLogLine } from "@wa-pi/shared";

let dir: string;
let projA: string;
let sysCwd: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-migrate-"));
	projA = join(dir, "proj-a");
	sysCwd = join(dir, "workdir");
	mkdirSync(projA, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLegacy(tasks: unknown[], records: unknown[]) {
	const tasksFile = join(dir, "scheduled-tasks.json");
	const recordsFile = join(dir, "execution-records.json");
	writeFileSync(tasksFile, JSON.stringify({ schemaVersion: 1, tasks }));
	writeFileSync(recordsFile, JSON.stringify({ schemaVersion: 1, records }));
	return { tasksFile, recordsFile };
}

const resolveProject = (projectId?: string) =>
	projectId === "pa" ? { id: "pa", cwd: projA } : { id: "__system__", cwd: sysCwd };

describe("migrateLegacySchedulerFiles", () => {
	test("无旧文件 → no-op", async () => {
		const r = await migrateLegacySchedulerFiles({
			legacyTasksFile: join(dir, "none.json"),
			legacyRecordsFile: join(dir, "none2.json"),
			resolveProject,
		});
		expect(r.migrated).toBe(0);
	});

	test("按 projectId 分发；无 projectId 进默认工作区；旧文件归档 .migrated", async () => {
		const { tasksFile, recordsFile } = writeLegacy(
			[
				{
					id: "uuid-1", name: "每日站会", schedule: { type: "daily", time: "09:30" },
					agentId: "main", prompt: "提醒站会", projectId: "pa",
					enabled: true, createdAt: 1, updatedAt: 2,
				},
				{
					id: "uuid-2", name: "全局提醒", schedule: { type: "daily", time: "08:00" },
					agentId: "main", prompt: "喝水", enabled: false, createdAt: 3, updatedAt: 4,
				},
			],
			[
				{ id: "r1", taskId: "uuid-1", taskName: "每日站会", status: "success", startedAt: 100 },
			],
		);
		const r = await migrateLegacySchedulerFiles({
			legacyTasksFile: tasksFile,
			legacyRecordsFile: recordsFile,
			resolveProject,
		});
		expect(r.migrated).toBe(2);
		// 任务文件落位，id 从 uuid 变为名称文件名
		const taskFile = join(tasksDirOf(projA), "每日站会.md");
		expect(existsSync(taskFile)).toBe(true);
		const task = parseTaskFile(readFileSync(taskFile, "utf8"), {
			taskId: "每日站会", projectId: "pa", createdAt: 1, updatedAt: 2,
		});
		expect(task.prompt).toBe("提醒站会");
		expect(task.enabled).toBe(true);
		expect(existsSync(join(tasksDirOf(sysCwd), "全局提醒.md"))).toBe(true);
		// 执行记录迁入对应 log，taskId 改写为新 id
		const log = readFileSync(join(logsDirOf(projA), "每日站会.log"), "utf8");
		const rec = parseLogLine(log.trim());
		expect(rec?.taskId).toBe("每日站会");
		// 归档
		expect(existsSync(tasksFile)).toBe(false);
		expect(existsSync(`${tasksFile}.migrated`)).toBe(true);
		expect(existsSync(`${recordsFile}.migrated`)).toBe(true);
	});

	test("迁移后重复执行 → no-op（旧文件已归档）", async () => {
		const f = writeLegacy([], []);
		await migrateLegacySchedulerFiles({ legacyTasksFile: f.tasksFile, legacyRecordsFile: f.recordsFile, resolveProject });
		const r = await migrateLegacySchedulerFiles({ legacyTasksFile: f.tasksFile, legacyRecordsFile: f.recordsFile, resolveProject });
		expect(r.migrated).toBe(0);
	});
});
