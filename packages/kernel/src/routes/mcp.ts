/**
 * MCP 域路由（阶段二·去 WS 化）
 *
 * projectId 一律从 query 取（可选，缺省为全局作用域）；
 * serverName 在路径参数或 body 中，与前端 REST 调用约定一致。
 * mcp:save / mcp:delete 无 reply（case 内直接 broadcast mcp:changed → SSE 总线），
 * 故成功时响应 200 {ok:true}；mcp:test / mcp:clearAuth 的失败也走 mcp:testResult
 * reply（非 error 类型），HTTP 状态仍为 200，由 body.success 区分。
 */
import type { RouteContext, RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerMcpRoutes: RouteRegistrar = (r, callApi, ctx) => {
  r.add("GET", "/api/mcp", async (req) => {
    const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
    return callApi({ type: "mcp:list", projectId });
  });

  r.add("POST", "/api/mcp", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "mcp:save",
      projectId: b.projectId, config: b.config, originalName: b.originalName,
    });
  });

  r.add("DELETE", "/api/mcp/:serverName", async (req, p) => {
    const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
    return callApi({ type: "mcp:delete", serverName: p.serverName, projectId });
  });

  r.add("POST", "/api/mcp/test", async (req) => {
    const b = await readJsonBody(req);
    // mcp:testResult 由 handler 显式 broadcast 到 SSE 总线（见 ws-server.ts），fire-and-forget。
    return callApi({ type: "mcp:test", serverName: b.serverName, projectId: b.projectId });
  });

  r.add("GET", "/api/mcp/:serverName/tools", async (req, p) => {
    const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
    // mcp:tools 由 handler 显式广播到 SSE 总线，fire-and-forget。
    return callApi({ type: "mcp:listTools", serverName: p.serverName, projectId });
  });

  r.add("POST", "/api/mcp/clear-auth", async (req) => {
    const b = await readJsonBody(req);
    // 同 mcp:test：mcp:testResult 由 handler 显式广播。
    return callApi({ type: "mcp:clearAuth", serverName: b.serverName, projectId: b.projectId });
  });
};
