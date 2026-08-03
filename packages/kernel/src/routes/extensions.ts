/**
 * 扩展域路由（阶段二·去 WS 化）
 *
 * install/upgrade/uninstall/toggle 的结果事件（extension:changed / extension:install:done /
 * extension:error）均由 ws-server handler 显式 broadcast 到 SSE 总线，前端 fire-and-forget
 * 丢弃 HTTP 响应体，仅靠 SSE 事件翻转状态。故此处不再需要 responseTypes / 错误状态码映射。
 */
import type { RouteRegistrar, RouteContext } from "./types";
import { readJsonBody } from "./types";

export const registerExtensionRoutes: RouteRegistrar = (r, callApi, ctx: RouteContext) => {
  r.add("GET", "/api/extensions", async () => callApi({ type: "extension:list" }));

  r.add("POST", "/api/extensions/toggle", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "extension:toggle", name: b.name, enabled: b.enabled });
  });

  r.add("POST", "/api/extensions/install", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "extension:install", name: b.name });
  });

  r.add("POST", "/api/extensions/uninstall", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "extension:uninstall", name: b.name });
  });

  r.add("POST", "/api/extensions/upgrade", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "extension:upgrade", name: b.name });
  });

  r.add("GET", "/api/extensions/commands", async () =>
    callApi({ type: "extension:commands:list" })
  );

  r.add("POST", "/api/extensions/commands/toggle", async (req) => {
    const b = await readJsonBody(req);
    if (!b?.packageName || !b?.command || typeof b.enabled !== "boolean") {
      return new Response(
        JSON.stringify({ error: "参数缺失或类型错误" }),
        { status: 400 }
      );
    }
    return callApi({ type: "extension:commands:toggle", ...b });
  });
};
