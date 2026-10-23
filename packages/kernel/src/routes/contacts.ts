/**
 * 企微机器人通讯录域路由（阶段二·去 WS 化）
 * 仿 channels.ts：GET 列表 / PUT 重命名，经 callApi 复用 ws-server 的 handle 业务逻辑。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerContactRoutes: RouteRegistrar = (r, callApi) => {
	// 某机器人的通讯录（channelId 空 = 全部）
	r.add("GET", "/api/contacts", async (req) => {
		const channelId = new URL(req.url).searchParams.get("channelId") ?? "";
		return callApi({ type: "contacts:list", channelId });
	});
	// 重命名
	r.add("PUT", "/api/contacts/:id", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({ type: "contacts:rename", id: p.id, remark: b.remark });
	});
	// 确保存在（顶部铅笔「自动补建后编辑」）
	r.add("POST", "/api/contacts/ensure", async (req) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "contacts:ensure",
			channelId: b.channelId,
			kind: b.kind,
			userId: b.userId,
			chatId: b.chatId,
		});
	});
	// 同步企微通讯录（搜索式）：用机器人 Bot ID+Secret 换 token 搜索成员合入通讯录
	r.add("POST", "/api/contacts/sync-wecom", async (req) => {
		const b = await readJsonBody(req);
		return callApi({
			type: "contacts:sync-wecom",
			channelId: b.channelId,
			keywords: Array.isArray(b.keywords) ? b.keywords : [],
		});
	});
};
