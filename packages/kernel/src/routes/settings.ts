/**
 * 通用设置域路由（系统设置 > 通用）：pi 自动重试 + HTTP 空闲超时配置读写
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import {
	loadTrashSettings,
	saveTrashSettings,
	loadProxySettings,
	saveProxySettings,
	applySystemProxy,
	loadShareSettings,
	saveShareSettings,
	loadLanguage,
	saveLanguage,
} from "../settings-store";

export const registerSettingsRoutes: RouteRegistrar = (r, callApi, ctx) => {
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
	// 系统代理设置（直接读写 settings.json + 立即应用环境变量 + 标脏重建 pi 进程）
	r.add("GET", "/api/settings/proxy", async () => {
		const proxy = await loadProxySettings();
		return Response.json({ proxy });
	});
	r.add("PUT", "/api/settings/proxy", async (req) => {
		const b = await readJsonBody(req);
		const saved = await saveProxySettings(b.proxy);
		await applySystemProxy();
		ctx.markAllDirty?.();
		return Response.json({ proxy: saved });
	});
	// 产物分享配置（直接读写 settings.json，不走 WS callApi；ctx.settingsFile 供测试注入隔离文件）
	// 安全：GET 不下发 token 明文，脱敏为 hasToken 布尔（渲染进程拿不到凭据）；
	// PUT 仍接收明文 token（用户输入），但回包同样脱敏。
	r.add("GET", "/api/settings/share", async () => {
		const share = await loadShareSettings(ctx.settingsFile);
		return Response.json({
			share: {
				hasToken: share.token !== "",
				channel: share.channel,
				customDomain: share.customDomain,
				accountId: share.accountId,
			},
		});
	});
	r.add("PUT", "/api/settings/share", async (req) => {
		const b = await readJsonBody(req);
		const saved = await saveShareSettings(b.share, ctx.settingsFile);
		return Response.json({
			share: {
				hasToken: saved.token !== "",
				channel: saved.channel,
				customDomain: saved.customDomain,
				accountId: saved.accountId,
			},
		});
	});
	// 界面语言偏好（后端 i18n 基建：前端切换语言时双写 kernel settings.json；
	// ctx.settingsFile 供测试注入隔离文件）。白名单校验在 saveLanguage（非法值 → 500 {error}）。
	r.add("GET", "/api/settings/language", async () => {
		const language = await loadLanguage(ctx.settingsFile);
		return Response.json({ language: language ?? null });
	});
	r.add("PUT", "/api/settings/language", async (req) => {
		const b = await readJsonBody(req);
		const language = await saveLanguage(b.language, ctx.settingsFile);
		return Response.json({ language });
	});
};
