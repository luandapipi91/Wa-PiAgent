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
import type { ScheduledTask } from "@wa-pi/shared";
import {
	loadScheduledTasks,
	saveScheduledTasks,
	loadExecutionRecords,
} from "../scheduler-store";

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
			const tasks = await loadScheduledTasks(tasksFile);
			tasks.push(task);
			await saveScheduledTasks(tasksFile, tasks);
			onTaskChanged(task);
			return new Response(JSON.stringify({ task }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// PUT /api/scheduled-tasks/:id — 更新任务
		r.add("PUT", "/api/scheduled-tasks/:id", async (req, params) => {
			const body = await readJsonBody(req);
			const tasks = await loadScheduledTasks(tasksFile);
			const idx = tasks.findIndex((t) => t.id === params.id);
			if (idx < 0) return new Response("Not found", { status: 404 });
			tasks[idx] = { ...tasks[idx], ...body, id: params.id, updatedAt: Date.now() };
			await saveScheduledTasks(tasksFile, tasks);
			onTaskChanged(tasks[idx]);
			return new Response(JSON.stringify({ task: tasks[idx] }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// DELETE /api/scheduled-tasks/:id — 删除任务
		r.add("DELETE", "/api/scheduled-tasks/:id", async (_req, params) => {
			const tasks = await loadScheduledTasks(tasksFile);
			const filtered = tasks.filter((t) => t.id !== params.id);
			await saveScheduledTasks(tasksFile, filtered);
			onTaskDeleted(params.id);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// POST /api/scheduled-tasks/:id/run — 立即执行
		r.add("POST", "/api/scheduled-tasks/:id/run", async (_req, params) => {
			await onRunNow(params.id);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		// GET /api/execution-records — 执行记录（支持 taskId/status 筛选，倒序，最多 200 条）
		r.add("GET", "/api/execution-records", async (req) => {
			const url = new URL(req.url);
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
