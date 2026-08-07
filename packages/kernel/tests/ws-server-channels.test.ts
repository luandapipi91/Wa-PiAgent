// ws-server 渠道相关 HTTP 语义：
// - channels:create/update 抛 ChannelConflictError → callApi 映射 409（其余错误 400）
// - agent:delete 响应携带渠道引用计数 channelRefs（渠道服务未启用时缺省）
import { test, expect } from "bun:test";
import { WSServer } from "../src/ws-server";
import { ChannelConflictError } from "../src/channel-manager";

function makeServer(overrides: {
	channelManager?: any;
	configStore?: any;
}) {
	return new WSServer({
		projectStore: { load: async () => ({ projects: [], sessions: [] }) },
		agentManager: {},
		channelManager: overrides.channelManager ?? null,
		configStore: overrides.configStore ?? {
			deleteAgent: async () => {},
			listAgents: async () => [],
		},
	} as any);
}

const baseChannel = {
	type: "mock",
	name: "x",
	enabled: true,
	credentials: { botId: "b1", secret: "s" },
	agentName: "",
	model: null,
	extraSystemPrompt: "",
	replyGranularity: "standard",
};

test("channels:create 抛 ChannelConflictError → HTTP 409", async () => {
	const server = makeServer({
		channelManager: {
			create: async () => {
				throw new ChannelConflictError("Bot ID 已被其他机器人使用");
			},
		},
	});
	const res = await server.callApi({ type: "channels:create", channel: baseChannel } as any);
	expect(res.status).toBe(409);
	expect(((await res.json()) as any).error).toContain("Bot ID");
});

test("channels:update 抛普通错误 → HTTP 400", async () => {
	const server = makeServer({
		channelManager: {
			update: async () => {
				throw new Error("机器人不存在");
			},
		},
	});
	const res = await server.callApi({
		type: "channels:update",
		id: "ch_x",
		channel: { name: "y" },
	} as any);
	expect(res.status).toBe(400);
});

test("agent:delete 响应携带渠道引用计数 channelRefs", async () => {
	const deleted: string[] = [];
	const server = makeServer({
		channelManager: {
			agentUsage: async (name: string) => ({
				count: 2,
				channelNames: ["机器人A", "机器人B"],
			}),
		},
		configStore: {
			deleteAgent: async (name: string) => {
				deleted.push(name);
			},
			listAgents: async () => [],
		},
	});
	const res = await server.callApi({ type: "agent:delete", name: "前端开发者" } as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("agent:deleted");
	expect(body.channelRefs).toEqual({ count: 2, channelNames: ["机器人A", "机器人B"] });
	expect(deleted).toEqual(["前端开发者"]);
});

test("agent:delete 渠道服务未启用 → 响应不含 channelRefs", async () => {
	const server = makeServer({ channelManager: null });
	const res = await server.callApi({ type: "agent:delete", name: "前端开发者" } as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("agent:deleted");
	expect(body.channelRefs).toBeUndefined();
});
