/**
 * 版本历史域路由（阶段二·去 WS 化）：只读，内核代拉线上历史。
 */
import type { RouteRegistrar } from "./types";

export const registerVersionHistoryRoutes: RouteRegistrar = (r, callApi) => {
  r.add("GET", "/api/version-history", async () =>
    callApi({ type: "version-history:get" }),
  );
};
