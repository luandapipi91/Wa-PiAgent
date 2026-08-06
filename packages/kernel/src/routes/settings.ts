/**
 * 通用设置域路由（系统设置 > 通用）：pi 自动重试 + HTTP 空闲超时配置读写
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerSettingsRoutes: RouteRegistrar = (r, callApi) => {
	r.add("GET", "/api/settings/retry", async () =>
		callApi({ type: "settings:get" }),
	);
	r.add("PUT", "/api/settings/retry", async (req) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "settings:save",
			retry: b.retry,
			httpIdleTimeoutMs: b.httpIdleTimeoutMs,
		});
	});
};
