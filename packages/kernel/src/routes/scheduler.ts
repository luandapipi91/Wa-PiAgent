/**
 * 定时任务 REST 路由（CRUD + 立即执行 + 执行记录查询）
 *
 * 与 channels/settings 等域不同，scheduler 域无对应 WSClientEvent，
 * 因此不走 callApi → handle() 适配器，而是直接读写文件夹存储层
 * （全部任务全局存储于 WA_PI_DIR/scheduled-tasks/）。
 * 闭包工厂模式：createSchedulerRoutes(...) 返回 RouteRegistrar，
 * 闭包捕获 FolderTaskStore 和三个调度器回调。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import type { ScheduledTask } from "@wa-pi/shared";
import { SYSTEM_PROJECT_ID, validateTaskData } from "@wa-pi/shared";
import type { FolderTaskStore } from "../scheduler-task-store";

/** 200 JSON 响应 */
function json(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		headers: { "Content-Type": "application/json" },
	});
}

/** 400 JSON 错误响应 */
function jsonError(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function createSchedulerRoutes(
	store: FolderTaskStore,
	onTaskChanged: (task: ScheduledTask) => void,
	onTaskDeleted: (taskId: string) => void,
	onRunNow: (taskId: string) => Promise<void>,
): RouteRegistrar {
	return (r, _callApi) => {
		// GET /api/scheduled-tasks — 任务列表（按 createdAt 倒序：新建任务排最前）
		// 解析失败的任务文件不丢：以 errors 条目随响应返回，前端可提示修复
		r.add("GET", "/api/scheduled-tasks", async () => {
			const { tasks, errors } = await store.listAll();
			tasks.sort((a, b) => b.createdAt - a.createdAt);
			return json({ tasks, errors });
		});

		// POST /api/scheduled-tasks — 新建任务
		r.add("POST", "/api/scheduled-tasks", async (req) => {
			const body = await readJsonBody(req);
			const error = validateTaskData(body);
			if (error) return jsonError(error, 400);
			try {
				const projectId =
					typeof body.projectId === "string" ? body.projectId : SYSTEM_PROJECT_ID;
				const task = await store.create(
					{
						name: body.name,
						schedule: body.schedule,
						agentId: body.agentId,
						model: typeof body.model === "string" ? body.model : undefined,
						enabled: body.enabled ?? true,
						projectId,
						prompt: body.prompt,
					},
					projectId,
				);
				onTaskChanged(task);
				return json({ task });
			} catch (err) {
				return jsonError(err instanceof Error ? err.message : String(err), 400);
			}
		});

		// PUT /api/scheduled-tasks/:id — 更新任务
		// 文件存在但解析失败时 findById 返回 null：走 upsert 修复路径
		// （body 必须完整合法，store.update 对坏文件覆盖写；文件不存在则 404）
		r.add("PUT", "/api/scheduled-tasks/:id", async (req, params) => {
			const body = await readJsonBody(req);
			const found = await store.findById(params.id);
			if (!found) {
				// 坏文件修复：body 必须完整合法
				const error = validateTaskData(body);
				if (error) return jsonError(error, 400);
				try {
					const projectId =
						typeof body.projectId === "string" ? body.projectId : SYSTEM_PROJECT_ID;
					const task = await store.update(params.id, {
						name: body.name,
						schedule: body.schedule,
						agentId: body.agentId,
						model: typeof body.model === "string" ? body.model : undefined,
						enabled: body.enabled ?? true,
						projectId,
						prompt: body.prompt,
					});
					if (!task) return new Response("Not found", { status: 404 });
					onTaskChanged(task);
					return json({ task });
				} catch (err) {
					return jsonError(err instanceof Error ? err.message : String(err), 400);
				}
			}
			// 部分更新也按完整任务校验（合并后再验）——PUT 语义为整体替换
			const merged = {
				...found.task,
				...body,
				schedule: body.schedule ?? found.task.schedule,
			};
			const error = validateTaskData(merged);
			if (error) return jsonError(error, 400);
			const task = await store.update(params.id, {
				name: merged.name,
				schedule: merged.schedule,
				agentId: merged.agentId,
				// model null（前端「跟随默认」）归一为 undefined，保持存储里 model 仅 string|undefined
				model: typeof merged.model === "string" ? merged.model : undefined,
				enabled: merged.enabled ?? true,
				projectId: merged.projectId,
				prompt: merged.prompt,
			});
			if (!task) return new Response("Not found", { status: 404 });
			onTaskChanged(task);
			return json({ task });
		});

		// DELETE /api/scheduled-tasks/:id — 删除任务（幂等；解析失败的文件也可删）
		r.add("DELETE", "/api/scheduled-tasks/:id", async (_req, params) => {
			await store.remove(params.id);
			onTaskDeleted(params.id);
			return json({ ok: true });
		});

		// POST /api/scheduled-tasks/:id/run — 立即执行（触发即返回）
		// 不 await 执行链（最长 30 分钟）：Bun.serve idleTimeout 255s 会先掐断连接；
		// 执行结果经 scheduled-task:completed SSE 广播，前端收到后刷新列表/记录。
		r.add("POST", "/api/scheduled-tasks/:id/run", async (_req, params) => {
			void onRunNow(params.id).catch((err) => {
				console.error(`[scheduler] 立即执行任务 ${params.id} 失败:`, err);
			});
			return json({ ok: true });
		});

		// GET /api/execution-records — 执行记录（支持 taskId/status 筛选，倒序，最多 200 条）
		r.add("GET", "/api/execution-records", async (req) => {
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return new Response("Invalid URL", { status: 400 });
			}
			const records = await store.listRecords({
				taskId: url.searchParams.get("taskId") ?? undefined,
				status: url.searchParams.get("status") ?? undefined,
			});
			return json({ records });
		});
	};
}
