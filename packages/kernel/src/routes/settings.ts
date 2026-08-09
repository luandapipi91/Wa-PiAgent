/**
 * 通用设置域路由（系统设置 > 通用）：pi 自动重试 + HTTP 空闲超时配置读写
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { loadTrashSettings, saveTrashSettings } from "../settings-store";

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
	// 回收站自动归档/清除设置（直接读写 settings.json，不走 WS callApi）
	r.add("GET", "/api/settings/trash", async () => {
		const trash = await loadTrashSettings();
		return Response.json({ trash });
	});
	r.add("PUT", "/api/settings/trash", async (req) => {
		const b = await readJsonBody(req);
		const saved = await saveTrashSettings(b.trash);
		return Response.json({ trash: saved });
	});
};
