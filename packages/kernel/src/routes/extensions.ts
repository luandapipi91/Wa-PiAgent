/**
 * 扩展域路由（阶段二·去 WS 化）
 */
import type { RouteRegistrar, RouteContext } from "./types";
import { readJsonBody } from "./types";

/**
 * extension 域错误 reply 类型为 extension:error（非通用 error），
 * callApi 只把 {type:"error"} 映射 400，这里在路由层补一道状态码映射。
 */
async function mapExtError(res: Response): Promise<Response> {
  const body = await res.clone().json().catch(() => null);
  if (body?.type === "extension:error") {
    return Response.json({ name: body.name, error: body.error }, { status: 400 });
  }
  return res;
}

export const registerExtensionRoutes: RouteRegistrar = (r, callApi, ctx: RouteContext) => {
  r.add("GET", "/api/extensions", async () => callApi({ type: "extension:list" }));

  r.add("POST", "/api/extensions/toggle", async (req) => {
    const b = await readJsonBody(req);
    return mapExtError(await callApi({ type: "extension:toggle", name: b.name, enabled: b.enabled }));
  });

  r.add("POST", "/api/extensions/install", async (req) => {
    const b = await readJsonBody(req);
    // replies 为 [progress..., extension:changed, extension:install:done]：
    // progress 帧自动走 SSE 总线；responseTypes 限定后 changed 也走总线，install:done 作响应体
    return mapExtError(await callApi(
      { type: "extension:install", name: b.name },
      { responseTypes: ["extension:install:done", "extension:error"] },
    ));
  });

  r.add("POST", "/api/extensions/uninstall", async (req) => {
    const b = await readJsonBody(req);
    return mapExtError(await callApi({ type: "extension:uninstall", name: b.name }));
  });

  r.add("POST", "/api/extensions/upgrade", async (req) => {
    const b = await readJsonBody(req);
    // 与 install 一致：progress 走总线，最后一个 extension:changed 作响应体
    return mapExtError(await callApi({ type: "extension:upgrade", name: b.name }));
  });
};
