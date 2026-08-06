/**
 * 渠道域路由测试（阶段二·去 WS 化 · IM 渠道机器人）
 *
 * 仿 tests/helpers/http-api-kit.ts 的 withServer 模式，但聚焦 channels 域：
 * - 复用真实 HttpRouter + registerChannelRoutes（端点定义不重复）
 * - callApi 内联 channels 域事件分派，与 ws-server.handle() 的对应 case 逐字对齐
 * - ChannelManager 用 stub（list/create/update/remove/agentUsage/listConversations/mockInbound/mockOutbox）
 *
 * 不复用 http-api-kit 的 withServer：它是 chat 域专用（callApi 只分派 chat 事件）。
 */
import { test, expect } from "bun:test";
import { HttpRouter } from "../src/http-router";
import { registerChannelRoutes } from "../src/routes/channels";
import type { WSClientEvent } from "@wa-pi/shared";

/** 满足 channels 域所需 ChannelManager 接口的最小桩（用例可改 list 注入数据） */
const stubManager = {
	list: [] as any[],
	async listWithStatus() {
		return this.list;
	},
	async create(input: any) {
		if (!input.credentials?.botId) throw new Error("Bot ID 不能为空");
		this.list.push({
			...input,
			id: "ch_x",
			status: "connected",
			credentials: { botId: input.credentials.botId, secret: "****" },
		});
	},
	async update(id: string, _patch: any) {
		if (!this.list.find((c: any) => c.id === id)) throw new Error("机器人不存在");
	},
	async remove(id: string) {
		this.list = this.list.filter((c: any) => c.id !== id);
	},
	async agentUsage(agentName: string) {
		return {
			count: agentName === "前端开发者" ? 1 : 0,
			channelNames: ["测试机器人"],
		};
	},
	async listConversations() {
		return [];
	},
	mockInbound(_channelId: string, _chatId: string, _text: string) {},
	mockOutbox(_channelId: string) {
		return [{ text: "回复" }];
	},
};

type StubManager = typeof stubManager;

/**
 * 随机端口起 HTTP 服务，挂载 channels 域路由；
 * callApi 复刻 WSServer.callApi + handle() 对 channels 域事件的分派。
 * fn 结束（含抛错）后自动停止服务。
 *
 * callApi 语义与 ws-server.callApi 逐字对齐：
 * - 最后一个 reply 为 {type:"error"} → 400 {error, ...}
 * - 否则 → 200，body 为最后一帧
 * - 无 reply（fire-and-forget）→ 200 {ok:true}
 */
async function withChannelsServer<T>(
	cm: StubManager,
	fn: (base: string) => Promise<T>,
): Promise<T> {
	const router = new HttpRouter();
	// callApi：内联 ws-server.handle() 的 channels case 分派到 stub ChannelManager
	const callApi = async (event: WSClientEvent): Promise<Response> => {
		let lastReply: any = null;
		const reply = (e: any) => {
			lastReply = e;
		};
		switch (event.type) {
			case "channels:list": {
				const channels = cm ? await cm.listWithStatus() : [];
				reply({ type: "channels:current", channels });
				break;
			}
			case "channels:create":
			case "channels:update":
			case "channels:delete": {
				try {
					if (event.type === "channels:create") await cm.create((event as any).channel);
					else if (event.type === "channels:update")
						await cm.update((event as any).id, (event as any).channel);
					else await cm.remove((event as any).id);
					reply({ type: "channels:current", channels: await cm.listWithStatus() });
				} catch (err) {
					reply({ type: "error", message: (err as Error).message });
				}
				break;
			}
			case "channels:agent-usage": {
				const usage = await cm.agentUsage((event as any).agentName);
				reply({
					type: "channels:agent-usage-result",
					agentName: (event as any).agentName,
					...usage,
				});
				break;
			}
			case "channel-conversations:list": {
				const conversations = cm ? await cm.listConversations() : [];
				reply({ type: "channel-conversations:current", conversations });
				break;
			}
			case "channels:mock-inbound" as any: {
				cm.mockInbound((event as any).id, (event as any).chatId, (event as any).text);
				reply({ type: "ok" });
				break;
			}
			case "channels:mock-outbox" as any: {
				const messages = cm.mockOutbox((event as any).id);
				reply({ type: "ok", messages });
				break;
			}
			default:
				return Response.json({ error: "not_found" }, { status: 404 });
		}
		if (!lastReply) return Response.json({ ok: true });
		if (lastReply.type === "error") {
			const { type: _t, message, ...rest } = lastReply;
			return Response.json({ ...rest, error: message }, { status: 400 });
		}
		return Response.json(lastReply);
	};
	registerChannelRoutes(router, callApi, { projectStore: null as any });

	const server = Bun.serve({
		port: 0,
		idleTimeout: 255, // 与生产一致：放宽空闲断连
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/api/")) {
				const res = await router.handle(req);
				return res ?? Response.json({ error: "not_found" }, { status: 404 });
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	try {
		return await fn(`http://127.0.0.1:${server.port}`);
	} finally {
		server.stop(true);
	}
}

test("GET /api/channels 返回脱敏列表（secret === '****'）", async () => {
	stubManager.list = [
		{
			id: "ch_x",
			name: "测试机器人",
			credentials: { botId: "b", secret: "****" },
			status: "connected",
		},
	];
	await withChannelsServer(stubManager, async (base) => {
		const res = await fetch(`${base}/api/channels`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.channels[0].credentials.secret).toBe("****");
	});
});

test("POST /api/channels 缺 botId → 400 中文错误", async () => {
	await withChannelsServer(stubManager, async (base) => {
		const res = await fetch(`${base}/api/channels`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				channel: { name: "x", credentials: { botId: "", secret: "s" } },
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toContain("Bot ID");
	});
});

test("GET /api/channels/agent-usage/:name 返回引用计数（中文名需 URL 编码）", async () => {
	await withChannelsServer(stubManager, async (base) => {
		const res = await fetch(
			`${base}/api/channels/agent-usage/${encodeURIComponent("前端开发者")}`,
		);
		const body = (await res.json()) as any;
		expect(body.count).toBe(1);
	});
});
