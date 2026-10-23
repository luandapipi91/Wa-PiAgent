import { beforeEach, expect, mock, test } from "bun:test";

const calls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
	api: {
		get: async (path: string) => {
			calls.push({ method: "GET", path });
			if (path === "/api/channels") {
				return { type: "channels:current", channels: [{ id: "ch_1", name: "客服" }] };
			}
			if (path === "/api/channel-conversations") {
				return { type: "channel-conversations:current", conversations: [{ sessionId: "s1" }] };
			}
			return {};
		},
		post: async (path: string, body: any) => {
			calls.push({ method: "POST", path, body });
			return { type: "channels:current", channels: [] };
		},
		put: async (path: string, body: any) => {
			calls.push({ method: "PUT", path, body });
			return { type: "channels:current", channels: [] };
		},
		del: async (path: string) => {
			calls.push({ method: "DELETE", path });
			return { type: "channels:current", channels: [] };
		},
	},
}));

const { useChannelsStore } = await import("../src/store/channels");

beforeEach(() => {
	calls.length = 0;
	useChannelsStore.setState({ bots: [], conversations: [] });
});

test("loadBots/loadConversations：拉取并写入 store", async () => {
	await useChannelsStore.getState().loadBots();
	await useChannelsStore.getState().loadConversations();
	expect(useChannelsStore.getState().bots[0].name).toBe("客服");
	expect(useChannelsStore.getState().conversations[0].sessionId).toBe("s1");
});

test("createBot：POST 载荷正确；deleteBot 走 api.del", async () => {
	await useChannelsStore.getState().createBot({ name: "x" } as any);
	expect(calls[0]).toMatchObject({ method: "POST", path: "/api/channels" });
	expect(calls[0].body.channel.name).toBe("x");
	await useChannelsStore.getState().deleteBot("ch_1");
	expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/channels/ch_1" });
});
