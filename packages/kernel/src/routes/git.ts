/**
 * Git 分支管理域路由（kernel 端）
 *
 * 闭包工厂模式（与 createSchedulerRoutes 一致）：createGitRoutes(broadcast)
 * 返回 RouteRegistrar，状态改变端点成功后广播 git:changed 供前端刷新。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody, paramErrorResponse } from "./types";
import {
	SYSTEM_PROJECT_ID,
	toKernelPayload,
	isValidBranchName,
} from "@wa-pi/shared";
import type { WSServerEvent } from "@wa-pi/shared";
import { resolveCwdForFsRequest } from "../ws-server";
import { ensureGitWatch } from "../git-watcher";
import {
	gitStatus,
	gitBranches,
	gitLog,
	gitCheckout,
	gitCreateBranch,
	gitPull,
} from "../git-service";
import { KernelError } from "../kernel-error";

/** KernelError → HTTP 响应：project.notFound 404，其余 400（git.unavailable 不返 500——无 git 是常见用户环境，不算服务端故障） */
function gitErrorResponse(e: unknown): Response {
	const payload = toKernelPayload(e);
	const status = payload?.code === "project.notFound" ? 404 : 400;
	return Response.json(
		{
			error: e instanceof Error ? e.message : String(e),
			...(payload ? { failure: payload } : {}),
		},
		{ status },
	);
}

export function createGitRoutes(
	broadcast: (e: WSServerEvent) => void,
): RouteRegistrar {
	return (r, _callApi, ctx) => {
		const projectStore = ctx.projectStore;

		/** 解析项目 cwd：__system__ 直接 400（无工作区语义）；项目不存在 404 */
		async function resolveProjectCwd(
			projectId: string,
		): Promise<{ cwd: string } | { res: Response }> {
			if (projectId === SYSTEM_PROJECT_ID) {
				return {
					res: Response.json(
						{
							error: "系统项目不支持 git 操作",
							failure: { code: "git.systemProject" },
						},
						{ status: 400 },
					),
				};
			}
			try {
				return { cwd: await resolveCwdForFsRequest(projectStore, projectId) };
			} catch (e) {
				return { res: gitErrorResponse(e) };
			}
		}

		// GET /api/projects/:projectId/git/status — 仓库状态（非 git 目录降级 200 isRepo:false）
		r.add("GET", "/api/projects/:projectId/git/status", async (_req, params) => {
			const resolved = await resolveProjectCwd(params.projectId);
			if ("res" in resolved) return resolved.res;
			try {
				const status = await gitStatus(resolved.cwd);
				// 是仓库则挂上变更监听：外部切换分支/提交时广播 git:changed 动态刷新前端
				if (status.isRepo)
					ensureGitWatch(params.projectId, resolved.cwd, broadcast);
				return Response.json(status);
			} catch (e) {
				// 非 git 目录 / 未安装 git 都不算错误：降级为 isRepo:false 的空状态（前端隐藏 Git 工具栏）
				if (
					e instanceof KernelError &&
					(e.code === "git.notRepo" || e.code === "git.unavailable")
				) {
					return Response.json({
						isRepo: false,
						branch: "",
						dirty: false,
						ahead: 0,
						behind: 0,
					});
				}
				return gitErrorResponse(e);
			}
		});

		// GET /api/projects/:projectId/git/branches — 本地分支列表（非仓库 400）
		r.add(
			"GET",
			"/api/projects/:projectId/git/branches",
			async (_req, params) => {
				const resolved = await resolveProjectCwd(params.projectId);
				if ("res" in resolved) return resolved.res;
				try {
					return Response.json(await gitBranches(resolved.cwd));
				} catch (e) {
					return gitErrorResponse(e);
				}
			},
		);

		// GET /api/projects/:projectId/git/log?limit=N — 提交历史（默认 200、上限 1000）
		r.add("GET", "/api/projects/:projectId/git/log", async (req, params) => {
			const resolved = await resolveProjectCwd(params.projectId);
			if ("res" in resolved) return resolved.res;
			const limit = parseLogLimit(new URL(req.url).searchParams.get("limit"));
			try {
				return Response.json(await gitLog(resolved.cwd, limit));
			} catch (e) {
				return gitErrorResponse(e);
			}
		});

		// POST /api/projects/:projectId/git/checkout {branch} — 切换分支，成功广播 git:changed
		r.add(
			"POST",
			"/api/projects/:projectId/git/checkout",
			async (req, params) => {
				const resolved = await resolveProjectCwd(params.projectId);
				if ("res" in resolved) return resolved.res;
				const b = await readJsonBody(req);
				if (typeof b.branch !== "string" || !b.branch)
					return paramErrorResponse("缺少 branch", "branch");
				try {
					await gitCheckout(resolved.cwd, b.branch);
					broadcast({ type: "git:changed", projectId: params.projectId });
					return Response.json({ ok: true, branch: b.branch });
				} catch (e) {
					return gitErrorResponse(e);
				}
			},
		);

		// POST /api/projects/:projectId/git/branch {name} — 新建并切换分支
		// 先 isValidBranchName 预检（非法直接 400，不调用 git），成功广播 git:changed
		r.add(
			"POST",
			"/api/projects/:projectId/git/branch",
			async (req, params) => {
				const resolved = await resolveProjectCwd(params.projectId);
				if ("res" in resolved) return resolved.res;
				const b = await readJsonBody(req);
				if (typeof b.name !== "string" || !isValidBranchName(b.name)) {
					return Response.json(
						{
							error: "非法分支名",
							failure: { code: "git.invalidBranchName" },
						},
						{ status: 400 },
					);
				}
				try {
					await gitCreateBranch(resolved.cwd, b.name);
					broadcast({ type: "git:changed", projectId: params.projectId });
					return Response.json({ ok: true, branch: b.name });
				} catch (e) {
					return gitErrorResponse(e);
				}
			},
		);

		// POST /api/projects/:projectId/git/pull — 拉取上游，成功广播 git:changed
		r.add("POST", "/api/projects/:projectId/git/pull", async (_req, params) => {
			const resolved = await resolveProjectCwd(params.projectId);
			if ("res" in resolved) return resolved.res;
			try {
				const result = await gitPull(resolved.cwd);
				broadcast({ type: "git:changed", projectId: params.projectId });
				return Response.json(result);
			} catch (e) {
				return gitErrorResponse(e);
			}
		});
	};
}

/** log limit 参数解析：缺省/非法 → 200，上限钳制 1000 */
export function parseLogLimit(raw: string | null): number {
	const n = raw === null ? NaN : Number(raw);
	if (!Number.isInteger(n) || n <= 0) return 200;
	return Math.min(n, 1000);
}
