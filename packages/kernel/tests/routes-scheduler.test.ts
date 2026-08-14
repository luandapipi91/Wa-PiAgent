/**
 * 定时任务域路由单元测试
 *
 * 使用真实 HttpRouter + createSchedulerRoutes（端点定义不重复），
 * 直接验证 CRUD + 执行记录查询 + 回调触发。
 * scheduler-store 读写真实临时文件（与 routes-channels 的 stub 模式不同，
 * scheduler 域不走 callApi 适配器，直接操作 JSON 文件）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HttpRouter } from "../src/http-router";
import { createSchedulerRoutes } from "../src/routes/scheduler";
import type { ScheduledTask } from "@wa-pi/shared";

let dir: string;
let tasksFile: string;
let recordsFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-sched-route-"));
	tasksFile = join(dir, "tasks.json");
	recordsFile = join(dir, "records.json");
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
		tasksFile,
		recordsFile,
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

test("GET /api/scheduled-tasks — 空列表", async () => {
	await withServer(async (base) => {
		const { status, body } = await json(base, "/api/scheduled-tasks");
		expect(status).toBe(200);
		expect(body.tasks).toEqual([]);
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
			}),
		});
		expect(created.task.name).toBe("日报");
		expect(created.task.id).toBeTruthy();
		expect(created.task.enabled).toBe(false);
		const id = created.task.id;

		// 查询列表
		const { body: list } = await json(base, "/api/scheduled-tasks");
		expect(list.tasks).toHaveLength(1);
		expect(list.tasks[0].id).toBe(id);

		// 更新
		const { body: updated } = await json(base, `/api/scheduled-tasks/${id}`, {
			method: "PUT",
			body: JSON.stringify({ name: "周报", enabled: true }),
		});
		expect(updated.task.name).toBe("周报");
		expect(updated.task.enabled).toBe(true);
		expect(updated.task.schedule.type).toBe("daily"); // 未改字段保留

		// 删除
		const { body: deleted } = await json(base, `/api/scheduled-tasks/${id}`, {
			method: "DELETE",
		});
		expect(deleted.ok).toBe(true);

		// 删除后列表为空
		const { body: empty } = await json(base, "/api/scheduled-tasks");
		expect(empty.tasks).toEqual([]);
	});
});

test("PUT 不存在的 id → 404", async () => {
	await withServer(async (base) => {
		const res = await fetch(`${base}/api/scheduled-tasks/nonexistent`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(404);
	});
});

test("POST 触发 onTaskChanged 回调", async () => {
	let changedTask: ScheduledTask | null = null;
	await withServer(
		async (base) => {
			await json(base, "/api/scheduled-tasks", {
				method: "POST",
				body: JSON.stringify({
					name: "回调测试",
					schedule: { type: "daily", time: "10:00" },
					agentId: "agent-1",
					prompt: "写日报",
				}),
			});
			expect(changedTask).not.toBeNull();
			expect(changedTask!.name).toBe("回调测试");
		},
		{ onTaskChanged: (t) => (changedTask = t) },
	);
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
				}),
			});
			await json(base, `/api/scheduled-tasks/${created.task.id}`, {
				method: "DELETE",
			});
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
				}),
			});
			// onRunNow 挂起直到测试手动放行
			hangPromise = new Promise<void>((resolve) => {
				release = resolve;
			});
			const res = await fetch(
				`${base}/api/scheduled-tasks/${created.task.id}/run`,
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

test("GET /api/execution-records — 空 + 筛选 + 倒序 + 200 上限", async () => {
	await withServer(async (base) => {
		// 空列表
		const { body: empty } = await json(base, "/api/execution-records");
		expect(empty.records).toEqual([]);

		// 写入测试记录（绕过路由，直接写文件）
		const { saveExecutionRecords } = await import("../src/scheduler-store");
		await saveExecutionRecords(recordsFile, [
			{
				id: "r1",
				taskId: "t1",
				taskName: "A",
				status: "success",
				startedAt: 100,
			},
			{
				id: "r2",
				taskId: "t1",
				taskName: "A",
				status: "failed",
				startedAt: 300,
			},
			{
				id: "r3",
				taskId: "t2",
				taskName: "B",
				status: "success",
				startedAt: 200,
			},
		]);

		// 全量（倒序：r2 > r3 > r1）
		const { body: all } = await json(base, "/api/execution-records");
		expect(all.records.map((r: any) => r.id)).toEqual(["r2", "r3", "r1"]);

		// taskId 筛选
		const { body: byTask } = await json(
			base,
			"/api/execution-records?taskId=t1",
		);
		expect(byTask.records).toHaveLength(2);
		expect(byTask.records.map((r: any) => r.id)).toEqual(["r2", "r1"]);

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
				`/api/scheduled-tasks/${created.task.id}`,
				{ method: "PUT", body: JSON.stringify({ name: "" }) },
			);
			expect(status).toBe(400);
			const { body: list } = await json(base, "/api/scheduled-tasks");
			expect(list.tasks[0].name).toBe("合法任务");
		});
	});
});
