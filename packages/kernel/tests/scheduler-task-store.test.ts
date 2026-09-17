import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createFolderTaskStore,
	tasksDirOf,
	logsDirOf,
	setScheduledTasksRoot,
} from "../src/scheduler-task-store";
import { errorCodeOf } from "./helpers/kernel-error-code";
import type { ExecutionRecord } from "@wa-pi/shared";

let dir: string;
let projA: string;
let projB: string;

// 全局化后：任务数据统一存全局 tasksDirOf()/logsDirOf()（不再按项目分散）。
// projects provider 仅用于 create 时校验 projectId 存在（定位文件不再遍历项目）。
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
	// 全局根切到临时目录，避免污染真实 ~/.pi/agent/scheduled-tasks
	setScheduledTasksRoot(join(dir, "scheduled-tasks"));
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
	test("create 写任务 md 到全局 tasks 目录，listAll 读全局并还原项目归属", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create(
			{ ...DATA, projectId: "pa", prompt: "提醒站会" },
			"pa",
		);
		expect(t1.id).toBe("每日站会");
		expect(t1.projectId).toBe("pa");
		// 全局目录（非项目目录）
		expect(existsSync(join(tasksDirOf(), "每日站会.md"))).toBe(true);
		const t2 = await store.create(
			{ ...DATA, name: "周报", projectId: "pb", prompt: "写周报" },
			"pb",
		);
		expect(t2.projectId).toBe("pb");
		const { tasks, errors } = await store.listAll();
		expect(errors).toEqual([]);
		expect(tasks.map((t) => t.name).sort()).toEqual(["周报", "每日站会"]);
		// projectId 从 frontmatter 还原
		expect(tasks.find((t) => t.name === "每日站会")?.projectId).toBe("pa");
		expect(tasks.find((t) => t.name === "周报")?.projectId).toBe("pb");
	});

	test("同名冲突自动追加 -2 后缀（跨项目同名也冲突，全局唯一）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create(
			{ ...DATA, projectId: "pa", prompt: "p1" },
			"pa",
		);
		// 不同项目同名 → 仍追加 -2（全局唯一 id）
		const t2 = await store.create(
			{ ...DATA, projectId: "pb", prompt: "p2" },
			"pb",
		);
		expect(t2.id).toBe("每日站会-2");
		expect(t1.id).not.toBe(t2.id);
	});

	test("含连续点点的名字可创建且能被 remove（id 折叠为 -，文件真的删除）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create(
			{ ...DATA, name: "生产..环境", projectId: "pa", prompt: "p" },
			"pa",
		);
		expect(t.id).toBe("生产-环境"); // id 不再含 ..（与 assertValidTaskId 一致，可被管理）
		const file = join(tasksDirOf(), "生产-环境.md");
		expect(existsSync(file)).toBe(true);
		expect(await store.remove(t.id)).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	test("未知 projectId 抛错", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		// 复用任务 3 的 project.notFound（同语义：项目不存在）
		expect(
			await errorCodeOf(
				store.create({ ...DATA, projectId: "nope", prompt: "p" }, "nope"),
			),
		).toBe("project.notFound");
	});
});

describe("解析失败文件", () => {
	test("坏文件进入 errors，不进入 tasks", async () => {
		mkdirSync(tasksDirOf(), { recursive: true });
		writeFileSync(join(tasksDirOf(), "坏任务.md"), "没有 frontmatter");
		const store = createFolderTaskStore({ projectsProvider: projects });
		const { tasks, errors } = await store.listAll();
		expect(tasks).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0].taskId).toBe("坏任务");
		expect(errors[0].error).toContain("frontmatter");
	});

	test("update 可修复坏文件（按 id 覆盖写），remove 可删坏文件", async () => {
		mkdirSync(tasksDirOf(), { recursive: true });
		const file = join(tasksDirOf(), "坏任务.md");
		writeFileSync(file, "没有 frontmatter");
		const store = createFolderTaskStore({ projectsProvider: projects });
		const fixed = await store.update("坏任务", {
			...DATA,
			projectId: "pa",
			prompt: "修好了",
		});
		expect(fixed?.id).toBe("坏任务");
		expect((await store.listAll()).errors).toEqual([]);
		expect(await store.remove("坏任务")).toBe(true);
		expect(existsSync(file)).toBe(false);
	});
});

describe("update/remove/findById", () => {
	test("update 保留 createdAt、刷新内容；rename（name 改动）不改文件名", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		const updated = await store.update(t.id, {
			...DATA,
			name: "新名字",
			projectId: "pa",
			prompt: "p2",
		});
		expect(updated?.name).toBe("新名字");
		expect(updated?.id).toBe(t.id); // id = 文件名，不随 name 变
		expect(updated?.projectId).toBe("pa"); // projectId 保留
		const found = await store.findById(t.id);
		expect(found?.task.prompt).toBe("p2");
		expect(found?.projectId).toBe("pa");
	});
	test("remove 不存在的 id 返回 false", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		expect(await store.remove("不存在")).toBe(false);
	});
});

describe("logs", () => {
	test("appendRecord 追加 log 行；同 id 记录读取时去重取最新（running→success）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		const rec = {
			id: "r1",
			taskId: t.id,
			taskName: t.name,
			status: "running" as const,
			startedAt: Date.now(),
		};
		await store.appendRecord("pa", t.id, rec);
		await store.appendRecord("pa", t.id, {
			...rec,
			status: "success" as const,
			finishedAt: Date.now(),
			durationMs: 1000,
			summary: "完成",
		});
		const logFile = join(logsDirOf(), `${t.id}.log`);
		expect(readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(2);
		const records = await store.listRecords({});
		expect(records).toHaveLength(1);
		expect(records[0].status).toBe("success");
		expect(records[0].summary).toBe("完成");
	});

	test("listRecords 支持 taskId/status 筛选，按 startedAt 倒序", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create(
			{ ...DATA, prompt: "p", projectId: "pa" },
			"pa",
		);
		const t2 = await store.create(
			{ ...DATA, name: "任务2", prompt: "p", projectId: "pa" },
			"pa",
		);
		await store.appendRecord("pa", t1.id, {
			id: "r1",
			taskId: t1.id,
			taskName: t1.name,
			status: "success",
			startedAt: 1000,
		});
		await store.appendRecord("pa", t2.id, {
			id: "r2",
			taskId: t2.id,
			taskName: t2.name,
			status: "failed",
			startedAt: 2000,
		});
		expect((await store.listRecords({ taskId: t1.id })).map((r) => r.id)).toEqual(
			["r1"],
		);
		expect(
			(await store.listRecords({ status: "failed" })).map((r) => r.id),
		).toEqual(["r2"]);
		expect((await store.listRecords({})).map((r) => r.id)).toEqual(["r2", "r1"]);
	});
});

// 造一次执行：running + 终态两行，与 executeTask 写入模式一致
async function runOnce(
	store: ReturnType<typeof createFolderTaskStore>,
	task: { id: string; name: string },
	i: number,
) {
	const base = { id: `r${i}`, taskId: task.id, taskName: task.name, startedAt: i * 100 };
	await store.appendRecord("pa", task.id, { ...base, status: "running" } as ExecutionRecord);
	await store.appendRecord("pa", task.id, {
		...base,
		status: "success",
		finishedAt: i * 100 + 50,
		summary: `结果${i}`,
	} as ExecutionRecord);
}

describe("执行记录尾读（taskId+limit）", () => {
	test("多轮执行取最新 N 条，startedAt 倒序，同 id 取终态", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		for (let i = 1; i <= 3; i++) await runOnce(store, t, i);
		const records = await store.listRecords({ taskId: t.id, limit: 2 });
		expect(records.map((r) => r.id)).toEqual(["r3", "r2"]);
		expect(records.every((r) => r.status === "success")).toBe(true); // 首遇即赢 = 终态
		// limit 覆盖全文件：与全量读等价
		expect((await store.listRecords({ taskId: t.id, limit: 10 })).map((r) => r.id)).toEqual([
			"r3",
			"r2",
			"r1",
		]);
	});

	test("损坏行跳过；文件不存在返回空", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		await runOnce(store, t, 1);
		// 手工追加损坏行（agent 手写/被截断的半行）
		writeFileSync(join(logsDirOf(), `${t.id}.log`), `这是被截断的半行 | {"broken\n`, { flag: "a" });
		const records = await store.listRecords({ taskId: t.id, limit: 5 });
		expect(records.map((r) => r.id)).toEqual(["r1"]);
		expect(await store.listRecords({ taskId: "不存在", limit: 3 })).toEqual([]);
	});

	test("首窗口不足时扩读重试（最新一行超长）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		// limit=1 首轮窗口 8KB；最新一条 summary 塞 500 中文字符（JSON 转义后远超 8KB）→ 首轮半行被丢弃，需扩读
		const base = { id: "r-big", taskId: t.id, taskName: t.name, startedAt: 100 };
		await store.appendRecord("pa", t.id, {
			...base,
			status: "success",
			summary: "长".repeat(500),
		} as ExecutionRecord);
		const records = await store.listRecords({ taskId: t.id, limit: 1 });
		expect(records.map((r) => r.id)).toEqual(["r-big"]);
		expect(records[0].summary).toBe("长".repeat(500));
	});
});

describe("latest 索引（appendRecord 同步维护 + listLatestRecords）", () => {
	test("appendRecord 写 <taskId>.latest.json = 最后一条；聚合每任务最新一条", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t1 = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		const t2 = await store.create({ ...DATA, name: "任务2", prompt: "p", projectId: "pa" }, "pa");
		const latestFile = join(logsDirOf(), `${t1.id}.latest.json`);
		await store.appendRecord("pa", t1.id, { id: "a1", taskId: t1.id, taskName: t1.name, status: "running", startedAt: 100 });
		expect(JSON.parse(readFileSync(latestFile, "utf8"))).toMatchObject({ id: "a1", status: "running" });
		await store.appendRecord("pa", t1.id, { id: "a1", taskId: t1.id, taskName: t1.name, status: "success", startedAt: 100, finishedAt: 150 });
		await store.appendRecord("pa", t2.id, { id: "b1", taskId: t2.id, taskName: t2.name, status: "failed", startedAt: 200 });
		expect(JSON.parse(readFileSync(latestFile, "utf8"))).toMatchObject({ id: "a1", status: "success" }); // 同 id 回写后索引跟随
		const latest = await store.listLatestRecords();
		expect(latest.map((r) => r.id)).toEqual(["b1", "a1"]); // startedAt 倒序
	});

	test("旧数据无索引 / 索引损坏：退化读日志尾 1 条，不抛错", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		await store.appendRecord("pa", t.id, { id: "x1", taskId: t.id, taskName: t.name, status: "success", startedAt: 100 });
		rmSync(join(logsDirOf(), `${t.id}.latest.json`)); // 模拟旧数据：只有 .log 无索引
		let latest = await store.listLatestRecords();
		expect(latest.map((r) => r.id)).toEqual(["x1"]);
		writeFileSync(join(logsDirOf(), `${t.id}.latest.json`), "{broken json", "utf8"); // 模拟索引损坏
		latest = await store.listLatestRecords();
		expect(latest.map((r) => r.id)).toEqual(["x1"]);
	});
});

describe("since 时间过滤", () => {
	test("只返回 startedAt >= since；taskId+since 组合不走尾读（正确性优先）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		for (let i = 1; i <= 3; i++) await runOnce(store, t, i); // startedAt 100/200/300
		const records = await store.listRecords({ taskId: t.id, since: 150, limit: 2 });
		expect(records.map((r) => r.id)).toEqual(["r3", "r2"]);
		expect((await store.listRecords({ since: 250 })).map((r) => r.id)).toEqual(["r3"]);
	});
});

describe("自写哈希", () => {
	test("store 写入的文件可通过 lastWrittenHash 识别（watcher 防循环用）", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		const file = join(tasksDirOf(), `${t.id}.md`);
		expect(store.lastWrittenHash(file)).not.toBeNull();
		expect(store.lastWrittenHash(join(tasksDirOf(), "别的.md"))).toBeNull();
	});
});

describe("并发安全", () => {
	test("并发同名 create 串行化，得到两个不同 id", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const [t1, t2] = await Promise.all([
			store.create({ ...DATA, prompt: "p1", projectId: "pa" }, "pa"),
			store.create({ ...DATA, prompt: "p2", projectId: "pa" }, "pa"),
		]);
		expect(t1.id).not.toBe(t2.id);
		expect([t1.id, t2.id].sort()).toEqual(["每日站会", "每日站会-2"]);
		const { tasks, errors } = await store.listAll();
		expect(errors).toEqual([]);
		expect(tasks).toHaveLength(2);
	});

	test("并发 update 同一文件：不抛错且最终内容完整", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		const t = await store.create({ ...DATA, prompt: "p", projectId: "pa" }, "pa");
		await Promise.all([
			store.update(t.id, { ...DATA, projectId: "pa", prompt: "u1" }),
			store.update(t.id, { ...DATA, projectId: "pa", prompt: "u2" }),
			store.update(t.id, { ...DATA, projectId: "pa", prompt: "u3" }),
		]);
		// 串行执行，最终内容为三者之一且可完整解析（无半写/tmp 冲突）
		const found = await store.findById(t.id);
		expect(found).not.toBeNull();
		expect(["u1", "u2", "u3"]).toContain(found!.task.prompt);
		expect((await store.listAll()).errors).toEqual([]);
	});
});

describe("taskId 路径穿越防护", () => {
	test("remove 非法 id 返回 false；appendRecord 非法 id 抛错", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		expect(await store.remove("../x")).toBe(false);
		const rec = {
			id: "r1",
			taskId: "../x",
			taskName: "x",
			status: "running" as const,
			startedAt: Date.now(),
		};
		await expect(store.appendRecord("pa", "../x", rec)).rejects.toThrow();
	});

	test("findById/update 对非法 id 不越出 tasks 目录", async () => {
		const store = createFolderTaskStore({ projectsProvider: projects });
		expect(await store.findById("../x")).toBeNull();
		await expect(
			store.update("..\\x", { ...DATA, projectId: "pa", prompt: "p" }),
		).rejects.toThrow();
		// 全局 tasks 目录之外不产生任何文件
		expect(existsSync(join(dir, "scheduled-tasks", "tasks", "x.md"))).toBe(false);
	});
});

// ---- 任务 4 i18n：KernelError code 断言 ----
test("非法 taskId → KernelError scheduler.invalidTaskId（appendRecord 路径）", async () => {
	const store = createFolderTaskStore({ projectsProvider: projects });
	const rec: ExecutionRecord = {
		id: "r-x",
		taskId: "../evil",
		taskName: "x",
		status: "running" as const,
		startedAt: Date.now(),
	};
	expect(await errorCodeOf(store.appendRecord("pa", "../evil", rec))).toBe(
		"scheduler.invalidTaskId",
	);
});
