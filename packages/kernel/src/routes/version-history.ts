/**
 * 版本历史域路由（阶段二·去 WS 化）：只读，内核代拉线上历史。
 */
import type { RouteRegistrar } from "./types";

export const registerVersionHistoryRoutes: RouteRegistrar = (r, callApi) => {
  r.add("GET", "/api/version-history", async (req) => {
    // refresh=1：绕过内核缓存重拉（发现新版本但历史里没有它时由前端触发）
    const url = new URL(req.url, "http://localhost");
    const refresh =
      url.searchParams.get("refresh") === "1" ||
      url.searchParams.get("refresh") === "true";
    return callApi(
      refresh
        ? { type: "version-history:get", refresh: true }
        : { type: "version-history:get" },
    );
  });
};
