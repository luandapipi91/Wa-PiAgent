/**
 * 扩展域路由（阶段二·去 WS 化）
 *
 * install/upgrade/uninstall/toggle 的结果事件（extension:changed / extension:install:done /
 * extension:error）均由 ws-server handler 显式 broadcast 到 SSE 总线，前端 fire-and-forget
 * 丢弃 HTTP 响应体，仅靠 SSE 事件翻转状态。故此处不再需要 responseTypes / 错误状态码映射。
 */
import type { RouteRegistrar, RouteContext } from "./types";
import { readJsonBody, paramErrorResponse } from "./types";

export const registerExtensionRoutes: RouteRegistrar = (
  r,
  callApi,
  ctx: RouteContext,
) => {
  r.add("GET", "/api/extensions", async () =>
    callApi({ type: "extension:list" }),
  );

  r.add("POST", "/api/extensions/toggle", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "extension:toggle",
      name: b.name,
      enabled: b.enabled,
    });
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

  r.add("POST", "/api/extensions/repair", async () =>
    callApi({ type: "extension:repair" }),
  );

  r.add("GET", "/api/extensions/commands", async () =>
    callApi({ type: "extension:commands:list" }),
  );

  r.add("POST", "/api/extensions/commands/toggle", async (req) => {
    const b = await readJsonBody(req);
    if (!b?.packageName || !b?.command || typeof b.enabled !== "boolean") {
      return paramErrorResponse(
        "参数缺失或类型错误",
        "packageName/command/enabled",
      );
    }
    return callApi({ type: "extension:commands:toggle", ...b });
  });

  r.add("POST", "/api/extensions/dialog/respond", async (req) => {
    const b = await readJsonBody(req);
    if (!b?.requestId) {
      return paramErrorResponse("参数缺失", "requestId");
    }
    return callApi({ type: "extension:dialog:respond", ...b });
  });

  // 扩展 TUI 面板输入（按键/粘贴/鼠标/尺寸/取消）：kernel 入队后由扩展的输入订阅流取走。
  // 线上体的输入类型字段名是 `type`（规格 §5.3），与事件判别字段同名，
  // 故显式映射到 inputType，不能整个 spread（会覆盖 type 导致事件分派不到）。
  r.add("POST", "/api/extensions/tui-input", async (req) => {
    const b = await readJsonBody(req);
    if (!b?.sessionId || !b?.panelId || !b?.type) {
      return paramErrorResponse("参数缺失", "sessionId/panelId/type");
    }
    return callApi({
      type: "extension:tui:input",
      sessionId: b.sessionId,
      panelId: b.panelId,
      inputType: b.type,
      data: b.data,
      cols: b.cols,
      rows: b.rows,
    });
  });

  // 扩展 TUI 面板快照（补发，规格 §5.4）：会话切换/前端重连时前端主动拉取。
  // 无面板/无该会话状态返回空 panels（不是 404：“没有面板”是合法态）。
  r.add("GET", "/api/extensions/tui-snapshot", async (req) => {
    const sessionId = new URL(req.url).searchParams.get("sessionId");
    if (!sessionId) {
      return paramErrorResponse("参数缺失", "sessionId");
    }
    return callApi({ type: "extension:tui:snapshot", sessionId });
  });
};
