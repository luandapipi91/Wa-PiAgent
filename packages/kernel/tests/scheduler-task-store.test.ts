import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createFolderTaskStore,
	tasksDirOf,
	logsDirOf,
} from "../src/scheduler-task-store";

let dir: string;
let projA: string;
let projB: string;

const projects = () =>
	Promise.resolve([
		{ id: "pa", cwd: projA },
		{ id: "pb", cwd: projB },
	]);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-task-store-"));
	projA = join(dir, "proj-a");
	projB = join(dir, "proj-b");
	mkdirSync(projA, { recursive: true });
	mkdirSync(projB, { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const DATA = {
	name: "每日站会",
	schedule: { type: "weekdays", time: "09:30" } as const,
	agentId: "main",
	enabled: true,
};

describe("create/list", () => {
	test("create 写任务 md 到对应项目 tasks 目录，listAll 聚合两项目", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create({ ...DATA, prompt: "提醒站会" }, "pa");
		expect(t1.id).toBe("每日站会");
		expect(t1.projectId).toBe("pa");
		expect(existsSync(join(tasksDirOf(projA), "每日站会.md"))).toBe(true);
		await store.create({ ...DATA, name: "周报", prompt: "写周报" }, "pb");
		const { tasks, errors } = await store.listAll();
		expect(errors).toEqual([]);
		expect(tasks.map((t) => t.name).sort()).toEqual(["周报", "每日站会"]);
	});

	test("同名冲突自动追加 -2 后缀", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create({ ...DATA, prompt: "p1" }, "pa");
		const t2 = await store.create({ ...DATA, prompt: "p2" }, "pa");
		expect(t2.id).toBe("每日站会-2");
		expect(t1.id).not.toBe(t2.id);
	});

	test("未知 projectId 抛错", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		await expect(store.create({ ...DATA, prompt: "p" }, "nope")).rejects.toThrow();
	});
});

describe("解析失败文件", () => {
	test("坏文件进入 errors，不进入 tasks", async () => {
		mkdirSync(tasksDirOf(projA), { recursive: true });
		writeFileSync(join(tasksDirOf(projA), "坏任务.md"), "没有 frontmatter");
		const store = createFolderTaskStore({ projectsProvider: projects });
		const { tasks, errors } = await store.listAll();
		expect(tasks).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0].taskId).toBe("坏任务");
		expect(errors[0].projectId).toBe("pa");
		expect(errors[0].error).toContain("frontmatter");
	});

	test("update 可修复坏文件（按 id 覆盖写），remove 可删坏文件", async () => {
		mkdirSync(tasksDirOf(projA), { recursive: true });
		const file = join(tasksDirOf(projA), "坏任务.md");
		writeFileSync(file, "没有 frontmatter");
		const store = createFolderTaskStore({ projectsProvider: projects });
		const fixed = await store.update("坏任务", { ...DATA, prompt: "修好了" });
		expect(fixed?.id).toBe("坏任务");
		expect((await store.listAll()).errors).toEqual([]);
		expect(await store.remove("坏任务")).toBe(true);
		expect(existsSync(file)).toBe(false);
	});
});

describe("update/remove/findById", () => {
	test("update 保留 createdAt、刷新内容；rename（name 改动）不改文件名", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p" }, "pa");
		const updated = await store.update(t.id, { ...DATA, name: "新名字", prompt: "p2" });
		expect(updated?.name).toBe("新名字");
		expect(updated?.id).toBe(t.id); // id = 文件名，不随 name 变
		const found = await store.findById(t.id);
		expect(found?.task.prompt).toBe("p2");
	});
	test("remove 不存在的 id 返回 false", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		expect(await store.remove("不存在")).toBe(false);
	});
});

describe("logs", () => {
	test("appendRecord 追加 log 行；同 id 记录读取时去重取最新（running→success）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p" }, "pa");
		const rec = {
			id: "r1", taskId: t.id, taskName: t.name, status: "running" as const,
			startedAt: Date.now(),
		};
		await store.appendRecord("pa", t.id, rec);
		await store.appendRecord("pa", t.id, {
			...rec, status: "success" as const, finishedAt: Date.now(),
			durationMs: 1000, summary: "完成",
		});
		const logFile = join(logsDirOf(projA), `${t.id}.log`);
		expect(readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(2);
		const records = await store.listRecords({});
		expect(records).toHaveLength(1);
		expect(records[0].status).toBe("success");
		expect(records[0].summary).toBe("完成");
	});

	test("listRecords 支持 taskId/status 筛选，按 startedAt 倒序", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create({ ...DATA, prompt: "p" }, "pa");
		const t2 = await store.create({ ...DATA, name: "任务2", prompt: "p" }, "pa");
		await store.appendRecord("pa", t1.id, {
			id: "r1", taskId: t1.id, taskName: t1.name, status: "success", startedAt: 1000,
		});
		await store.appendRecord("pa", t2.id, {
			id: "r2", taskId: t2.id, taskName: t2.name, status: "failed", startedAt: 2000,
		});
		expect((await store.listRecords({ taskId: t1.id })).map((r) => r.id)).toEqual(["r1"]);
		expect((await store.listRecords({ status: "failed" })).map((r) => r.id)).toEqual(["r2"]);
		expect((await store.listRecords({})).map((r) => r.id)).toEqual(["r2", "r1"]);
	});
});

describe("自写哈希", () => {
	test("store 写入的文件可通过 lastWrittenHash 识别（watcher 防循环用）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p" }, "pa");
		const file = join(tasksDirOf(projA), `${t.id}.md`);
		expect(store.lastWrittenHash(file)).not.toBeNull();
		expect(store.lastWrittenHash(join(tasksDirOf(projA), "别的.md"))).toBeNull();
	});
});
