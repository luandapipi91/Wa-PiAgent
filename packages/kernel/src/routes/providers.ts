/**
 * Provider / 模型域路由（阶段二·去 WS 化）
 */
import type { RouteContext, RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerProviderRoutes: RouteRegistrar = (r, callApi, ctx: RouteContext) => {
  r.add("GET", "/api/providers", async () => callApi({ type: "provider:list" }));
  r.add("POST", "/api/providers", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "provider:save", provider: b.provider });
  });
  r.add("DELETE", "/api/providers/:name", async (_req, p) =>
    callApi({ type: "provider:delete", id: p.name }));
  r.add("POST", "/api/providers/test", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "provider:test",
      baseUrl: b.baseUrl, apiKey: b.apiKey, api: b.api, models: b.models, slug: b.slug,
    });
  });
  r.add("GET", "/api/models/presets", async () => callApi({ type: "model:presets" }));
};
