/**
 * IM 渠道机器人域路由（阶段二·去 WS 化）
 *
 * 将 /api/channels* REST 端点映射到原 channels:* WSClientEvent，
 * 经 callApi 适配器复用 ws-server.handle() 业务逻辑（ChannelManager 调用）。
 *
 * 状态码约定：callApi 对 handle() 最后一个 reply 为 {type:"error"} 的返回 HTTP 400；
 * reply 携带 status 字段时按其映射（Bot ID 冲突 ChannelConflictError → 409）。
 * 其余业务 reply 返回 200。与 routes/settings.ts 同模式。
 *
 * mock 端点（mock-inbound / mock-outbox）仅在 WA_PI_CHANNELS_MOCK=1 时注册，
 * 供 E2E 测试使用；生产环境不暴露。其事件类型未进 WSClientEvent 联合（测试专用），
 * callApi 入参用 as any 兜底。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerChannelRoutes: RouteRegistrar = (r, callApi) => {
	// 列表（脱敏，含连接状态）
	r.add("GET", "/api/channels", async () =>
		callApi({ type: "channels:list" }),
	);
	// 新建（全量刷新返回）
	r.add("POST", "/api/channels", async (req) => {
		const b = await readJsonBody(req);
		return callApi({ type: "channels:create", channel: b.channel });
	});
	// 更新
	r.add("PUT", "/api/channels/:id", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({ type: "channels:update", id: p.id, channel: b.channel });
	});
	// 删除
	r.add("DELETE", "/api/channels/:id", async (_req, p) =>
		callApi({ type: "channels:delete", id: p.id }),
	);
	// 智能体引用计数（删除智能体前的确认提示用）
	r.add("GET", "/api/channels/agent-usage/:agentName", async (_req, p) =>
		callApi({ type: "channels:agent-usage", agentName: p.agentName }),
	);
	// 渠道会话列表
	r.add("GET", "/api/channel-conversations", async () =>
		callApi({ type: "channel-conversations:list" }),
	);

	// mock 测试端点：仅 WA_PI_CHANNELS_MOCK=1 注册（E2E 用，生产不暴露）
	if (process.env.WA_PI_CHANNELS_MOCK === "1") {
		r.add("POST", "/api/channels/:id/mock-inbound", async (req, p) => {
			const b = await readJsonBody(req);
			return callApi({
				type: "channels:mock-inbound",
				id: p.id,
				chatId: b.chatId,
				text: b.text,
			} as any);
		});
		r.add("GET", "/api/channels/:id/mock-outbox", async (_req, p) =>
			callApi({ type: "channels:mock-outbox", id: p.id } as any),
		);
	}
};
