/**
 * Agent 管理 + subagent 域路由（阶段二·去 WS 化）
 */
import type { RouteRegistrar, RouteContext } from "./types";
import { readJsonBody } from "./types";

export const registerAgentRoutes: RouteRegistrar = (r, callApi, ctx: RouteContext) => {
  r.add("GET", "/api/agents", async () => callApi({ type: "agent:list" }));
  r.add("POST", "/api/agents", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "agent:create", displayName: b.displayName });
  });
  r.add("DELETE", "/api/agents/:name", async (_req, p) =>
    callApi({ type: "agent:delete", name: p.name }));
  r.add("GET", "/api/agents/tools", async () => callApi({ type: "agent:tools:list" }));
  r.add("GET", "/api/agents/:name/config", async (_req, p) =>
    callApi({ type: "agent:config:get", agentName: p.name }));
  r.add("PUT", "/api/agents/:name/config", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({ type: "agent:config:save", agentName: p.name, config: b.config });
  });
  r.add("GET", "/api/subagents", async () => callApi({ type: "subagent:list" }));
  r.add("PUT", "/api/subagents/override", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "subagent:save-override", override: b.override });
  });
};
