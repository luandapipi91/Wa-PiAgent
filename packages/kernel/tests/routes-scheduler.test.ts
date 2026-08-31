/**
 * 定时任务域路由单元测试
 *
 * 使用真实 HttpRouter + createSchedulerRoutes（端点定义不重复），
 * 直接验证 CRUD + 执行记录查询 + 回调触发。
 * 数据源为文件夹存储：临时项目目录 + createFolderTaskStore
 * （scheduler 域不走 callApi 适配器，直接操作项目下 .wa-pi/scheduled-tasks/）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HttpRouter } from "../src/http-router";
import { createSchedulerRoutes } from "../src/routes/scheduler";
import {
	createFolderTaskStore,
	tasksDirOf,
	setScheduledTasksRoot,
	type FolderTaskStore,
	type ProjectRef,
} from "../src/scheduler-task-store";
import {
	SYSTEM_PROJECT_ID,
	serializeTaskFile,
	type ExecutionRecord,
	type ScheduledTask,
} from "@wa-pi/shared";

let dir: string;
let projA: string;
let projB: string;
let sysProj: string;
let projects: ProjectRef[];
let store: FolderTaskStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-sched-route-"));
	projA = join(dir, "proj-a");
	projB = join(dir, "proj-b");
	sysProj = join(dir, "sys");
	mkdirSync(projA, { recursive: true });
	mkdirSync(projB, { recursive: true });
	mkdirSync(sysProj, { recursive: true });
	// 全局根切到临时目录（任务数据统一存 tasksDirOf()/logsDirOf()，项目仅用于 create 校验）
	setScheduledTasksRoot(join(dir, "scheduled-tasks"));
	projects = [
		{ id: "pa", cwd: projA },
		{ id: "pb", cwd: projB },
		{ id: SYSTEM_PROJECT_ID, cwd: sysProj },
	];
	store = createFolderTaskStore({ projectsProvider: async () => projects });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** 起临时 HTTP 服务挂载 scheduler 路由 */
async function withServer<T>(
	fn: (base: string) => Promise<T>,
	opts?: {
		onTaskChanged?: (t: ScheduledTask) => void;
		onTaskDeleted?: (id: string) => void;
		onRunNow?: (id: string) => Promise<void>;
	},
): Promise<T> {
	const router = new HttpRouter();
	const registrar = createSchedulerRoutes(
		store,
		opts?.onTaskChanged ?? (() => {}),
		opts?.onTaskDeleted ?? (() => {}),
		opts?.onRunNow ?? (async () => {}),
	);
	registrar(router, (async () => new Response()) as any, {} as any);

	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const res = await router.handle(req);
			return res ?? new Response("not found", { status: 404 });
		},
	});
	const base = `http://localhost:${server.port}`;
	try {
		return await fn(base);
	} finally {
		server.stop();
	}
}

async function json(base: string, path: string, init?: RequestInit) {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
	});
	return { status: res.status, body: await res.json() };
}

/** 直接在全局任务目录写一个合法任务文件（绕过 POST，造数据用） */
function writeTaskFile(
	taskId: string,
	overrides: { name?: string; projectId?: string } = {},
): void {
	mkdirSync(tasksDirOf(), { recursive: true });
	writeFileSync(
		join(tasksDirOf(), `${taskId}.md`),
		serializeTaskFile(
			{
				name: overrides.name ?? taskId,
				schedule: { type: "daily", time: "09:00" },
				agentId: "agent-1",
				enabled: true,
				projectId: overrides.projectId ?? "pa",
			},
			"x",
		),
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("GET /api/scheduled-tasks — 空列表（tasks 与 errors 均为空）", async () => {
	await withServer(async (base) => {
		const { status, body } = await json(base, "/api/scheduled-tasks");
		expect(status).toBe(200);
		expect(body.tasks).toEqual([]);
		expect(body.errors).toEqual([]);
	});
});

test("GET /api/scheduled-tasks — 按 createdAt 倒序（新建任务排最前）", async () => {
	// 直接写任务文件造数据；createdAt 取自文件 birthtime，间隔写保证时序可区分
	writeTaskFile("旧任务");
	await sleep(30);
	writeTaskFile("中任务");
	await sleep(30);
	writeTaskFile("新任务");
	await withServer(async (base) => {
		const { body } = await json(base, "/api/scheduled-tasks");
		expect(body.tasks.map((t: ScheduledTask) => t.id)).toEqual([
			"新任务",
			"中任务",
			"旧任务",
		]);
	});
});

test("GET /api/scheduled-tasks 返回 tasks + errors（含解析失败条目）", async () => {
	writeTaskFile("好任务");
	mkdirSync(tasksDirOf(), { recursive: true });
	writeFileSync(join(tasksDirOf(), "坏任务.md"), "没有 frontmatter");
	await withServer(async (base) => {
		const { status, body } = await json(base, "/api/scheduled-tasks");
		expect(status).toBe(200);
		// 好任务正常列出
		expect(body.tasks.map((t: ScheduledTask) => t.id)).toEqual(["好任务"]);
		// 解析失败文件进 errors（taskId = 文件名去 .md）
		expect(body.errors).toHaveLength(1);
		expect(body.errors[0].taskId).toBe("坏任务");
		// 全局化后 projectId 从 frontmatter 读；坏文件无 frontmatter 因此 projectId 为空
		expect(body.errors[0].projectId).toBe("");
		expect(typeof body.errors[0].error).toBe("string");
	});
});

test("POST 创建后任务文件落在 projectId 对应目录；未传 projectId 进默认项目", async () => {
	let changedTask: ScheduledTask | null = null;
	await withServer(
		async (base) => {
			const { status, body } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					name: "每日站会",
					schedule: { type: "daily", time: "09:30" },
					agentId: "agent-1",
					prompt: "写站会纪要",
					projectId: "pa",
				}),
			});
			expect(status).toBe(200);
			// id = sanitizeTaskId(name)，任务文件落在 pa 项目目录
			expect(body.task.id).toBe("每日站会");
			expect(body.task.projectId).toBe("pa");
			expect(existsSync(join(tasksDirOf(), "每日站会.md"))).toBe(true);
			// onTaskChanged 被调
			expect(changedTask).not.toBeNull();
			expect(changedTask!.id).toBe("每日站会");

			// 未传 projectId → 进默认项目（SYSTEM_PROJECT_ID）
			const { body: sysCreated } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					name: "默认项目任务",
					schedule: { type: "daily", time: "10:00" },
					agentId: "agent-1",
					prompt: "x",
				}),
			});
			expect(sysCreated.task.projectId).toBe(SYSTEM_PROJECT_ID);
			expect(existsSync(join(tasksDirOf(), "默认项目任务.md"))).toBe(true);
		},
		{ onTaskChanged: (t) => (changedTask = t) },
	);
});

test("POST projectId 不存在 → 400（store 抛错映射为 400）", async () => {
	await withServer(async (base) => {
		const { status, body } = await json(base, "/api/scheduled-tasks", {
			method: "POST",
			body: JSON.stringify({
				name: "x",
				schedule: { type: "daily", time: "09:30" },
				agentId: "agent-1",
				prompt: "x",
				projectId: "no-such-project",
			}),
		});
		expect(status).toBe(400);
		expect(typeof body.error).toBe("string");
	});
});

test("POST → GET → PUT → DELETE 完整 CRUD", async () => {
	await withServer(async (base) => {
		// 创建
		const { body: created } = await json(base, "/api/scheduled-tasks", {
			method: "POST",
			body: JSON.stringify({
				name: "日报",
				schedule: { type: "daily", time: "09:30" },
				agentId: "agent-1",
				prompt: "写日报",
				enabled: false,
				projectId: "pa",
			}),
		});
		expect(created.task.name).toBe("日报");
		expect(created.task.id).toBe("日报");
		expect(created.task.enabled).toBe(false);
		const id = created.task.id;

		// 查询列表
		const { body: list } = await json(base, "/api/scheduled-tasks");
		expect(list.tasks).toHaveLength(1);
		expect(list.tasks[0].id).toBe(id);

		// 更新
		const { body: updated } = await json(
			base,
			`/api/scheduled-tasks/${encodeURIComponent(id)}`,
			{
				method: "PUT",
				body: JSON.stringify({ name: "周报", enabled: true }),
			},
		);
		expect(updated.task.name).toBe("周报");
		expect(updated.task.enabled).toBe(true);
		expect(updated.task.schedule.type).toBe("daily"); // 未改字段保留

		// 删除
		const { body: deleted } = await json(
			base,
			`/api/scheduled-tasks/${encodeURIComponent(id)}`,
			{ method: "DELETE" },
		);
		expect(deleted.ok).toBe(true);

		// 删除后列表为空
		const { body: empty } = await json(base, "/api/scheduled-tasks");
		expect(empty.tasks).toEqual([]);
	});
});

test("PUT 不存在的 id（body 完整合法）→ 404", async () => {
	await withServer(async (base) => {
		const res = await fetch(`${base}/api/scheduled-tasks/nonexistent`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "x",
				schedule: { type: "daily", time: "09:30" },
				agentId: "agent-1",
				prompt: "x",
			}),
		});
		expect(res.status).toBe(404);
	});
});

test("PUT 修复解析失败文件（upsert）：200 且 errors 清空", async () => {
	mkdirSync(tasksDirOf(), { recursive: true });
	writeFileSync(join(tasksDirOf(), "坏任务.md"), "没有 frontmatter");
	await withServer(async (base) => {
		// 坏文件存在：GET 时进 errors
		const { body: before } = await json(base, "/api/scheduled-tasks");
		expect(before.errors).toHaveLength(1);

		// PUT 完整合法 body → 覆盖写修复
		const { status, body } = await json(
			base,
			`/api/scheduled-tasks/${encodeURIComponent("坏任务")}`,
			{
				method: "PUT",
				body: JSON.stringify({
					name: "坏任务",
					schedule: { type: "daily", time: "09:30" },
					agentId: "agent-1",
					prompt: "修复后的指令",
				}),
			},
		);
		expect(status).toBe(200);
		expect(body.task.id).toBe("坏任务");

		// 再 GET：errors 清空、tasks 含该任务
		const { body: after } = await json(base, "/api/scheduled-tasks");
		expect(after.errors).toEqual([]);
		expect(after.tasks.map((t: ScheduledTask) => t.id)).toEqual(["坏任务"]);
	});
});

test("PUT 修复解析失败文件但 body 不完整 → 400", async () => {
	mkdirSync(tasksDirOf(), { recursive: true });
	writeFileSync(join(tasksDirOf(), "坏任务.md"), "没有 frontmatter");
	await withServer(async (base) => {
		const { status } = await json(
			base,
			`/api/scheduled-tasks/${encodeURIComponent("坏任务")}`,
			{ method: "PUT", body: JSON.stringify({ name: "坏任务" }) },
		);
		expect(status).toBe(400);
	});
});

test("DELETE 可删除解析失败文件", async () => {
	mkdirSync(tasksDirOf(), { recursive: true });
	const badFile = join(tasksDirOf(), "坏任务.md");
	writeFileSync(badFile, "没有 frontmatter");
	await withServer(async (base) => {
		const { status, body } = await json(
			base,
			`/api/scheduled-tasks/${encodeURIComponent("坏任务")}`,
			{ method: "DELETE" },
		);
		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(existsSync(badFile)).toBe(false);
	});
});

test("DELETE 触发 onTaskDeleted 回调", async () => {
	let deletedId: string | null = null;
	await withServer(
		async (base) => {
			const { body: created } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					name: "删除测试",
					schedule: { type: "daily", time: "10:00" },
					agentId: "agent-1",
					prompt: "x",
					projectId: "pa",
				}),
			});
			await json(
				base,
				`/api/scheduled-tasks/${encodeURIComponent(created.task.id)}`,
				{ method: "DELETE" },
			);
			expect(deletedId).toBe(created.task.id);
		},
		{ onTaskDeleted: (id) => (deletedId = id) },
	);
});

// I1：run 端点触发即返回——onRunNow 挂起不阻塞响应（旧实现 await 执行链，
// Bun.serve idleTimeout 255s 会先掐断连接）
test("POST /:id/run 触发即返回：onRunNow 未完成时响应已返回", async () => {
	let release: (() => void) | null = null;
	let runId: string | null = null;
	let hangPromise: Promise<void> = Promise.resolve();
	await withServer(
		async (base) => {
			const { body: created } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					name: "立即执行",
					schedule: { type: "daily", time: "10:00" },
					agentId: "agent-1",
					prompt: "x",
					projectId: "pa",
				}),
			});
			// onRunNow 挂起直到测试手动放行
			hangPromise = new Promise<void>((resolve) => {
				release = resolve;
			});
			const res = await fetch(
				`${base}/api/scheduled-tasks/${encodeURIComponent(created.task.id)}/run`,
				{ method: "POST" },
			);
			// 响应在 onRunNow 挂起期间已返回（触发即返回）
			expect(res.status).toBe(200);
			expect((await res.json()).ok).toBe(true);
			expect(runId).toBe(created.task.id);
			release?.();
			await hangPromise;
		},
		{
			onRunNow: async (id) => {
				runId = id;
				await hangPromise;
			},
		},
	);
});

test("GET /api/execution-records 从 logs 聚合，响应结构与旧版一致", async () => {
	// 经 store.appendRecord 写入两条不同项目的执行记录（含 sessionId/pushResults）
	const r1: ExecutionRecord = {
		id: "r1",
		taskId: "t1",
		taskName: "A",
		status: "success",
		startedAt: 100,
		sessionId: "sess-1",
		pushResults: [{ targetId: "ct_1", targetName: "张三", success: true }],
	};
	const r2: ExecutionRecord = {
		id: "r2",
		taskId: "t1",
		taskName: "A",
		status: "failed",
		startedAt: 300,
	};
	const r3: ExecutionRecord = {
		id: "r3",
		taskId: "t2",
		taskName: "B",
		status: "success",
		startedAt: 200,
	};
	await store.appendRecord("pa", "t1", r1);
	await store.appendRecord("pa", "t1", r2);
	await store.appendRecord("pb", "t2", r3);

	await withServer(async (base) => {
		// 全量（倒序：r2 > r3 > r1），字段完整（sessionId/pushResults 保留）
		const { body: all } = await json(base, "/api/execution-records");
		expect(all.records.map((r: ExecutionRecord) => r.id)).toEqual([
			"r2",
			"r3",
			"r1",
		]);
		const rec1 = all.records.find((r: ExecutionRecord) => r.id === "r1");
		expect(rec1.sessionId).toBe("sess-1");
		expect(rec1.pushResults).toEqual([
			{ targetId: "ct_1", targetName: "张三", success: true },
		]);

		// taskId 筛选
		const { body: byTask } = await json(base, "/api/execution-records?taskId=t1");
		expect(byTask.records.map((r: ExecutionRecord) => r.id)).toEqual([
			"r2",
			"r1",
		]);

		// status 筛选
		const { body: byStatus } = await json(
			base,
			"/api/execution-records?status=failed",
		);
		expect(byStatus.records).toHaveLength(1);
		expect(byStatus.records[0].id).toBe("r2");
	});
});

// ── I2：POST/PUT 入口校验（坏任务不落盘，直接 400）──
describe("POST/PUT 校验", () => {
	const validTask = {
		name: "合法任务",
		schedule: { type: "daily", time: "09:30" },
		agentId: "agent-1",
		prompt: "写日报",
		projectId: "pa",
	};

	test("POST 缺 name/agentId/prompt → 400 + 错误信息，不落盘", async () => {
		await withServer(async (base) => {
			for (const patch of [{ name: "" }, { agentId: "" }, { prompt: "" }]) {
				const { status, body } = await json(base, "/api/scheduled-tasks", {
					method: "POST",
					body: JSON.stringify({ ...validTask, ...patch }),
				});
				expect(status).toBe(400);
				expect(typeof body.error).toBe("string");
			}
			// 坏任务全部被拦：列表仍为空
			const { body: list } = await json(base, "/api/scheduled-tasks");
			expect(list.tasks).toEqual([]);
		});
	});

	test("POST schedule.type 非法 → 400", async () => {
		await withServer(async (base) => {
			const { status } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					...validTask,
					schedule: { type: "yearly", time: "09:30" },
				}),
			});
			expect(status).toBe(400);
		});
	});

	test("POST schedule.type 支持 minute / hourly → 200", async () => {
		await withServer(async (base) => {
			for (const schedule of [
				{ type: "minute", time: "09:30", intervalMinutes: 5 },
				{ type: "hourly", time: "09:30", intervalHours: 3, startTime: "07:30" },
			]) {
				const { status, body } = await json(base, "/api/scheduled-tasks", {
					method: "POST",
					body: JSON.stringify({ ...validTask, schedule }),
				});
				expect(status).toBe(200);
				expect(body.task.schedule.type).toBe(schedule.type);
			}
		});
	});

	test("POST time 非 HH:MM → 400", async () => {
		await withServer(async (base) => {
			for (const time of ["9:30", "0930", "25:00", "09:60", "abc"]) {
				const { status } = await json(base, "/api/scheduled-tasks", {
					method: "POST",
					body: JSON.stringify({
						...validTask,
						schedule: { type: "daily", time },
					}),
				});
				expect(status).toBe(400);
			}
		});
	});

	test("POST custom 缺 cronExpression → 400；合法 custom → 200", async () => {
		await withServer(async (base) => {
			const missing = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					...validTask,
					schedule: { type: "custom", time: "09:30" },
				}),
			});
			expect(missing.status).toBe(400);
			expect(missing.body.error).toContain("cronExpression");

			const ok = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					...validTask,
					schedule: {
						type: "custom",
						time: "09:30",
						cronExpression: "*/5 * * * *",
					},
				}),
			});
			expect(ok.status).toBe(200);
		});
	});

	test("PUT 把 name 改空 → 400，任务保持原值", async () => {
		await withServer(async (base) => {
			const { body: created } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify(validTask),
			});
			const { status } = await json(
				base,
				`/api/scheduled-tasks/${encodeURIComponent(created.task.id)}`,
				{ method: "PUT", body: JSON.stringify({ name: "" }) },
			);
			expect(status).toBe(400);
			const { body: list } = await json(base, "/api/scheduled-tasks");
			expect(list.tasks[0].name).toBe("合法任务");
		});
	});

	test("POST 带 model → 透传保存；不带 → undefined（跟随默认）", async () => {
		await withServer(async (base) => {
			const withModel = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({ ...validTask, model: "openai/gpt-4" }),
			});
			expect(withModel.status).toBe(200);
			expect(withModel.body.task.model).toBe("openai/gpt-4");

			const noModel = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify(validTask),
			});
			expect(noModel.body.task.model).toBeUndefined();
		});
	});

	test("POST model 非字符串（非 null）→ 400", async () => {
		await withServer(async (base) => {
			for (const bad of [123, {}, [], true]) {
				const { status } = await json(base, "/api/scheduled-tasks", {
					method: "POST",
					body: JSON.stringify({ ...validTask, model: bad }),
				});
				expect(status).toBe(400);
			}
		});
	});

	test("PUT 更新 model；传 null 清空 model（回跟随默认）", async () => {
		await withServer(async (base) => {
			const { body: created } = await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({ ...validTask, model: "openai/gpt-4" }),
			});
			const { body: updated } = await json(
				base,
				`/api/scheduled-tasks/${encodeURIComponent(created.task.id)}`,
				{ method: "PUT", body: JSON.stringify({ model: "anthropic/claude" }) },
			);
			expect(updated.task.model).toBe("anthropic/claude");

			// 传 null 清空（前端「跟随默认」选项）
			const { body: cleared } = await json(
				base,
				`/api/scheduled-tasks/${encodeURIComponent(created.task.id)}`,
				{ method: "PUT", body: JSON.stringify({ model: null }) },
			);
			expect(cleared.task.model).toBeUndefined();
		});
	});
});
