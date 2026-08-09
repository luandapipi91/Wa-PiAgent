/**
 * 项目 / 会话域路由（阶段二·去 WS 化）
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { readSessionHistory } from "../session-history";

export const registerProjectSessionRoutes: RouteRegistrar = (
	r,
	callApi,
	ctx,
) => {
	r.add("GET", "/api/projects", async () => callApi({ type: "projects:list" }));
	// 以下写操作 case 成功时均无 reply → 200 {ok:true}，副作用走 broadcast（SSE 总线）
	r.add("POST", "/api/projects", async (req) => {
		const b = await readJsonBody(req);
		return callApi({ type: "project:create", name: b.name, cwd: b.cwd });
	});
	r.add("PATCH", "/api/projects/:projectId", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "project:update",
			projectId: p.projectId,
			name: b.name,
			cwd: b.cwd,
		});
	});
	r.add("DELETE", "/api/projects/:projectId", async (_req, p) =>
		callApi({ type: "project:delete", projectId: p.projectId }),
	);
	r.add("POST", "/api/projects/:projectId/open-dir", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "project:open-dir",
			projectId: p.projectId,
			sessionId: b.sessionId,
		});
	});
	r.add("POST", "/api/sessions/:sessionId/rename", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "session:rename",
			sessionId: p.sessionId,
			title: b.title,
		});
	});
	r.add("DELETE", "/api/sessions/:sessionId", async (_req, p) =>
		callApi({ type: "session:delete", sessionId: p.sessionId }),
	);
	r.add("GET", "/api/sessions/:sessionId/messages", async (_req, p) =>
		callApi({ type: "session:messages", sessionId: p.sessionId }),
	);
	// 会话 token 统计（累计消耗 + 当前上下文占用）；进程存活时走 pi get_session_stats，
	// 否则本地 jsonl 全量累计降级。
	r.add("GET", "/api/sessions/:sessionId/stats", async (_req, p) =>
		callApi({ type: "session:stats", sessionId: p.sessionId }),
	);
	// ask double check：返回该 session 当前真实 pending 的 ask toolCallId 列表
	r.add("GET", "/api/sessions/:sessionId/asks", async (_req, p) =>
		callApi({ type: "session:asks", sessionId: p.sessionId }),
	);
	r.add("POST", "/api/sessions/:sessionId/set-agent", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "session:set-agent",
			sessionId: p.sessionId,
			agentName: b.agentName,
		});
	});
	r.add("POST", "/api/sessions/:sessionId/reload", async (_req, p) =>
		callApi({ type: "session:reload", sessionId: p.sessionId }),
	);
	r.add("GET", "/api/sessions/:sessionId/commands", async (req, p) => {
		const url = new URL(req.url);
		return callApi({
			type: "session:commands",
			sessionId: p.sessionId,
			projectId: url.searchParams.get("projectId") || undefined,
			agentName: url.searchParams.get("agentName") || undefined,
		});
	});
	// ===== 回收站（软删除会话）HTTP 路由 =====
	r.add("GET", "/api/trash/sessions", async (req) => {
		const url = new URL(req.url, "http://localhost");
		const projectId = url.searchParams.get("projectId") ?? undefined;
		const offset = url.searchParams.get("offset")
			? Number(url.searchParams.get("offset"))
			: undefined;
		const limit = url.searchParams.get("limit")
			? Number(url.searchParams.get("limit"))
			: undefined;
		return callApi({ type: "trash:list", projectId, offset, limit });
	});
	r.add("POST", "/api/trash/sessions/restore", async (req) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "trash:restore",
			sessionIds: b.sessionIds ?? [],
		});
	});
	r.add("DELETE", "/api/trash/sessions", async (req) => {
		const b = await readJsonBody(req);
		if (b.sessionIds && Array.isArray(b.sessionIds)) {
			return callApi({ type: "trash:delete", sessionIds: b.sessionIds });
		}
		return callApi({ type: "trash:empty" });
	});
	// 回收站只读消息查看：直接读 jsonl，不经过 AgentManager（已 dispose 的会话不走 touch/prewarm）
	r.add("GET", "/api/trash/sessions/:sessionId/messages", async (_req, p) => {
		const { sessions } = await ctx.projectStore.load();
		const session = sessions.find((s) => s.id === p.sessionId);
		if (!session || !session.piSessionFile) {
			return Response.json({ messages: [] });
		}
		try {
			const history = await readSessionHistory(session.piSessionFile);
			const messages = history.map((m) => ({
				message: m,
				agentName: session.primaryAgent,
			}));
			return Response.json({ messages });
		} catch {
			return Response.json({ messages: [] });
		}
	});
};
