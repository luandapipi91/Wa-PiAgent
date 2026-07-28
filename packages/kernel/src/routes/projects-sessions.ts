/**
 * 项目 / 会话域路由（阶段二·去 WS 化）
 */
import type { RouteContext, RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerProjectSessionRoutes: RouteRegistrar = (r, callApi, ctx) => {
  r.add("GET", "/api/projects", async () => callApi({ type: "projects:list" }));
  // 以下写操作 case 成功时均无 reply → 200 {ok:true}，副作用走 broadcast（SSE 总线）
  r.add("POST", "/api/projects", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "project:create", name: b.name, cwd: b.cwd });
  });
  r.add("PATCH", "/api/projects/:projectId", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({ type: "project:update", projectId: p.projectId, name: b.name, cwd: b.cwd });
  });
  r.add("DELETE", "/api/projects/:projectId", async (_req, p) =>
    callApi({ type: "project:delete", projectId: p.projectId }));
  r.add("POST", "/api/projects/:projectId/open-dir", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({ type: "project:open-dir", projectId: p.projectId, sessionId: b.sessionId });
  });
  r.add("POST", "/api/sessions/:sessionId/rename", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({ type: "session:rename", sessionId: p.sessionId, title: b.title });
  });
  r.add("DELETE", "/api/sessions/:sessionId", async (_req, p) =>
    callApi({ type: "session:delete", sessionId: p.sessionId }));
  r.add("GET", "/api/sessions/:sessionId/messages", async (_req, p) =>
    callApi({ type: "session:messages", sessionId: p.sessionId }));
  r.add("POST", "/api/sessions/:sessionId/set-agent", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({ type: "session:set-agent", sessionId: p.sessionId, agentName: b.agentName });
  });
  r.add("POST", "/api/sessions/:sessionId/reload", async (_req, p) =>
    callApi({ type: "session:reload", sessionId: p.sessionId }));
  r.add("GET", "/api/sessions/:sessionId/commands", async (req, p) => {
    const url = new URL(req.url);
    return callApi({
      type: "session:commands",
      sessionId: p.sessionId,
      projectId: url.searchParams.get("projectId") || undefined,
      agentName: url.searchParams.get("agentName") || undefined,
    });
  });
};
