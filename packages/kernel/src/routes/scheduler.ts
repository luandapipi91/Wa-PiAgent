/**
 * 定时任务 REST 路由（CRUD + 立即执行 + 执行记录查询）
 *
 * 与 channels/settings 等域不同，scheduler 域无对应 WSClientEvent，
 * 因此不走 callApi → handle() 适配器，而是直接读写 scheduler-store JSON 文件。
 * 闭包工厂模式：createSchedulerRoutes(...) 返回 RouteRegistrar，
 * 闭包捕获 tasksFile/recordsFile 路径和三个调度器回调。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { randomUUID } from "node:crypto";
import type { ScheduledTask, TaskSchedule } from "@wa-pi/shared";
import {
	loadScheduledTasks,
	mutateScheduledTasks,
	loadExecutionRecords,
} from "../scheduler-store";

/** 合法的 schedule.type 值（与 shared/types.ts TaskSchedule 联合类型一致） */
const SCHEDULE_TYPES = [
	"daily",
	"weekdays",
	"weekly",
	"monthly",
	"custom",
] as const;

/** "HH:MM" 24 小时制（00-23:00-59）：格式 + 范围双查（"25:00" 格式对但越界） */
const TIME_RE = /^(\d{2}):(\d{2})$/;

function isValidTime(time: string): boolean {
	const m = TIME_RE.exec(time);
	if (!m) return false;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h <= 23 && min <= 59;
}

/**
 * POST/PUT 请求体校验。返回 null 表示合法，否则返回 400 响应的错误信息。
 * 坏任务落盘后调度注册抛错 → 假 500 → 重启静默失效，故入口处拦截。
 */
function validateTaskBody(body: {
	name?: unknown;
	agentId?: unknown;
	prompt?: unknown;
	schedule?: unknown;
}): string | null {
	if (typeof body.name !== "string" || !body.name.trim())
		return "name 不能为空";
	if (typeof body.agentId !== "string" || !body.agentId.trim())
		return "agentId 不能为空";
	if (typeof body.prompt !== "string" || !body.prompt.trim())
		return "prompt 不能为空";
	const schedule = body.schedule as Partial<TaskSchedule> | undefined;
	if (!schedule || typeof schedule !== "object") return "schedule 不能为空";
	if (
		!SCHEDULE_TYPES.includes(schedule.type as (typeof SCHEDULE_TYPES)[number])
	)
		return `schedule.type 必须是 ${SCHEDULE_TYPES.join("/")} 之一`;
	if (typeof schedule.time !== "string" || !isValidTime(schedule.time))
		return "schedule.time 必须是 HH:MM 格式（如 09:30，00-23:00-59）";
	if (schedule.type === "custom") {
		if (
			typeof schedule.cronExpression !== "string" ||
			!schedule.cronExpression.trim()
		)
			return "schedule.type 为 custom 时 cronExpression 不能为空";
	}
	return null;
}

export function createSchedulerRoutes(
	tasksFile: string,
	recordsFile: string,
	onTaskChanged: (task: ScheduledTask) => void,
	onTaskDeleted: (taskId: string) => void,
	onRunNow: (taskId: string) => Promise<void>,
): RouteRegistrar {
	return (r, _callApi) => {
		// GET /api/scheduled-tasks — 任务列表
		r.add("GET", "/api/scheduled-tasks", async () => {
			const tasks = await loadScheduledTasks(tasksFile);
			return new Response(JSON.stringify({ tasks }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// POST /api/scheduled-tasks — 新建任务
		r.add("POST", "/api/scheduled-tasks", async (req) => {
			const body = await readJsonBody(req);
			const error = validateTaskBody(body);
			if (error)
				return new Response(JSON.stringify({ error }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			const now = Date.now();
			const task: ScheduledTask = {
				id: randomUUID(),
				name: body.name ?? "",
				schedule: body.schedule,
				agentId: body.agentId ?? "",
				prompt: body.prompt ?? "",
				projectId: body.projectId,
				enabled: body.enabled ?? true,
				createdAt: now,
				updatedAt: now,
			};
			// 读改写经 mutateScheduledTasks 原子入队，避免与并发写互吞
			await mutateScheduledTasks(tasksFile, (tasks) => [...tasks, task]);
			onTaskChanged(task);
			return new Response(JSON.stringify({ task }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// PUT /api/scheduled-tasks/:id — 更新任务
		r.add("PUT", "/api/scheduled-tasks/:id", async (req, params) => {
			const body = await readJsonBody(req);
			// 部分更新也按完整任务校验（合并后再验）——PUT 语义为整体替换
			const tasks = await loadScheduledTasks(tasksFile);
			const existing = tasks.find((t) => t.id === params.id);
			if (!existing) return new Response("Not found", { status: 404 });
			const merged = {
				...existing,
				...body,
				schedule: body.schedule ?? existing.schedule,
			};
			const error = validateTaskBody(merged);
			if (error)
				return new Response(JSON.stringify({ error }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			const updated: ScheduledTask = {
				...merged,
				id: params.id,
				updatedAt: Date.now(),
			};
			await mutateScheduledTasks(tasksFile, (list) =>
				list.map((t) => (t.id === params.id ? updated : t)),
			);
			onTaskChanged(updated);
			return new Response(JSON.stringify({ task: updated }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// DELETE /api/scheduled-tasks/:id — 删除任务
		r.add("DELETE", "/api/scheduled-tasks/:id", async (_req, params) => {
			await mutateScheduledTasks(tasksFile, (tasks) =>
				tasks.filter((t) => t.id !== params.id),
			);
			onTaskDeleted(params.id);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// POST /api/scheduled-tasks/:id/run — 立即执行（触发即返回）
		// 不 await 执行链（最长 5 分钟）：Bun.serve idleTimeout 255s 会先掐断连接；
		// 执行结果经 scheduled-task:completed SSE 广播，前端收到后刷新列表/记录。
		r.add("POST", "/api/scheduled-tasks/:id/run", async (_req, params) => {
			void onRunNow(params.id).catch((err) => {
				console.error(`[scheduler] 立即执行任务 ${params.id} 失败:`, err);
			});
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// GET /api/execution-records — 执行记录（支持 taskId/status 筛选，倒序，最多 200 条）
		r.add("GET", "/api/execution-records", async (req) => {
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return new Response("Invalid URL", { status: 400 });
			}
			const taskId = url.searchParams.get("taskId");
			const status = url.searchParams.get("status");
			let records = await loadExecutionRecords(recordsFile);
			if (taskId) records = records.filter((rec) => rec.taskId === taskId);
			if (status) records = records.filter((rec) => rec.status === status);
			records = records.sort((a, b) => b.startedAt - a.startedAt).slice(0, 200);
			return new Response(JSON.stringify({ records }), {
				headers: { "Content-Type": "application/json" },
			});
		});
	};
}
