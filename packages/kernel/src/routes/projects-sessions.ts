/**
 * 项目 / 会话域路由（阶段二·去 WS 化）
 */
import { readdir } from "node:fs/promises";
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { readSessionHistory } from "../session-history";
import {
	assertAgentId,
	readMeta,
	jsonlPath,
	subagentDir,
} from "../subagent-instance-store";

/**
 * 子代理转录只读读取（规格 §8）：不走 AgentManager，直接 readSessionHistory 解析 jsonl
 *（与回收站只读先例同款）。
 *
 * 校验顺序硬约束（Ruling 9）：先 assertAgentId → 400，再 readMeta → 404。
 * 反了会让 400 退化成 404（readMeta 内部把非法 id 静默吞成 null）。
 * 入参永不接受裸路径：目录由 sessionId 定位，agentId 必须过 assertAgentId 后才拼文件名。
 */
export async function handleSubagentMessages(
	sessionId: string,
	agentId: string,
): Promise<Response> {
	try {
		assertAgentId(agentId);
	} catch {
		return Response.json({ error: "invalid_agent_id" }, { status: 400 });
	}
	const meta = await readMeta(sessionId, agentId);
	if (!meta) return Response.json({ error: "subagent_not_found" }, { status: 404 });
	try {
		const history = await readSessionHistory(jsonlPath(sessionId, agentId));
		return Response.json({ meta, messages: history.map((m) => ({ message: m })) });
	} catch {
		return Response.json({ error: "transcript_not_found" }, { status: 404 });
	}
}

/** 会话内子代理实例列表（备用入口） */
export async function handleSubagentList(sessionId: string): Promise<Response> {
	try {
		const files = await readdir(subagentDir(sessionId));
		const ids = files
			.filter((f) => f.endsWith(".meta.json"))
			.map((f) => f.replace(".meta.json", ""));
		const metas = (await Promise.all(ids.map((id) => readMeta(sessionId, id)))).filter(
			Boolean,
		);
		return Response.json({ subagents: metas });
	} catch {
		return Response.json({ subagents: [] });
	}
}

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
	// ===== 子代理转录（只读，直接读 jsonl，不激活 pi 进程）=====
	r.add("GET", "/api/sessions/:sessionId/subagents/:agentId", async (_req, p) =>
		handleSubagentMessages(p.sessionId, p.agentId),
	);
	r.add("GET", "/api/sessions/:sessionId/subagents", async (_req, p) =>
		handleSubagentList(p.sessionId),
	);
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
