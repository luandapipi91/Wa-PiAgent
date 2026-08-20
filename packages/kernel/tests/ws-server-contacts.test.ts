// ws-server 通讯录事件语义：
// - contacts:list channelManager 为 null → reply contacts:current 空数组
// - contacts:list channelManager 存在 → listContacts(channelId) + reply contacts:current
// - contacts:rename 空 channelManager → error + 400（通讯录未启用）
// - contacts:rename id 不存在 → error + 404
// - contacts:rename renameContact 抛错 → error + 500
// - contacts:rename 成功 → broadcast contacts:changed + reply contacts:current（返回全量）
import { test, expect } from "bun:test";
import { WSServer } from "../src/ws-server";

function makeServer(channelManager: any) {
	return new WSServer({
		projectStore: { load: async () => ({ projects: [], sessions: [] }) },
		agentManager: {},
		channelManager,
		configStore: {
			deleteAgent: async () => {},
			listAgents: async () => [],
		},
	} as any);
}

const baseContact = {
	id: "ct_1",
	channelId: "ch_1",
	kind: "person",
	remark: "李四",
	firstChatAt: 1,
	lastChatAt: 2,
};

test("contacts:list channelManager 为 null → reply contacts:current 空数组", async () => {
	const server = makeServer(null);
	const res = await server.callApi({
		type: "contacts:list",
		channelId: "",
	} as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("contacts:current");
	expect(body.contacts).toEqual([]);
});

test("contacts:list channelManager 存在 → listContacts(channelId) + reply contacts:current", async () => {
	const listedChannelIds: (string | undefined)[] = [];
	const server = makeServer({
		listContacts: async (channelId?: string) => {
			listedChannelIds.push(channelId);
			return [{ ...baseContact }];
		},
	});
	const res = await server.callApi({
		type: "contacts:list",
		channelId: "ch_1",
	} as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("contacts:current");
	expect(body.contacts).toEqual([{ ...baseContact }]);
	expect(listedChannelIds).toEqual(["ch_1"]);
});

test("contacts:rename channelManager 为 null → HTTP 400（通讯录未启用）", async () => {
	const server = makeServer(null);
	const res = await server.callApi({
		type: "contacts:rename",
		id: "ct_1",
		remark: "张三",
	} as any);
	expect(res.status).toBe(400);
	expect(((await res.json()) as any).error).toBe("通讯录未启用");
});

test("contacts:rename id 不存在 → HTTP 404", async () => {
	const server = makeServer({
		renameContact: async () => null,
		listContacts: async () => [],
	});
	const res = await server.callApi({
		type: "contacts:rename",
		id: "ct_missing",
		remark: "张三",
	} as any);
	expect(res.status).toBe(404);
	expect(((await res.json()) as any).error).toBe("联系人不存在");
});

test("contacts:rename renameContact 抛错 → HTTP 500 + err.message", async () => {
	const server = makeServer({
		renameContact: async () => {
			throw new Error("存储 I/O 失败");
		},
		listContacts: async () => [],
	});
	const res = await server.callApi({
		type: "contacts:rename",
		id: "ct_1",
		remark: "张三",
	} as any);
	expect(res.status).toBe(500);
	expect(((await res.json()) as any).error).toBe("存储 I/O 失败");
});

test("contacts:rename 成功 → broadcast contacts:changed + reply contacts:current（返回全量）", async () => {
	const listedChannelIds: (string | undefined)[] = [];
	const server = makeServer({
		renameContact: async (id: string, remark: string) => ({
			...baseContact,
			id,
			remark,
		}),
		listContacts: async (channelId?: string) => {
			listedChannelIds.push(channelId);
			return [
				{ ...baseContact, remark: "张三" },
				{ ...baseContact, id: "ct_2", channelId: "ch_2", remark: "王五" },
			];
		},
	});

	const broadcasted: any[] = [];
	const origBroadcast = server.broadcast.bind(server);
	server.broadcast = (e: any) => {
		broadcasted.push(e);
		origBroadcast(e);
	};

	const res = await server.callApi({
		type: "contacts:rename",
		id: "ct_1",
		remark: "张三",
	} as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("contacts:current");
	expect(body.contacts).toEqual([
		{ ...baseContact, remark: "张三" },
		{ ...baseContact, id: "ct_2", channelId: "ch_2", remark: "王五" },
	]);
	// 广播 contacts:changed 且 listContacts 以无参（全量）调用
	expect(broadcasted.some((e) => e.type === "contacts:changed")).toBe(true);
	expect(listedChannelIds).toEqual([undefined]);
});

test("contacts:ensure channelManager 为 null → HTTP 400（通讯录未启用）", async () => {
	const server = makeServer(null);
	const res = await server.callApi({
		type: "contacts:ensure",
		channelId: "ch_1",
		kind: "person",
		userId: "u1",
	} as any);
	expect(res.status).toBe(400);
	expect(((await res.json()) as any).error).toBe("通讯录未启用");
});

test("contacts:ensure 成功 → 透传匹配键给 ensureContact + reply contacts:ensured", async () => {
	const ensuredInputs: any[] = [];
	const server = makeServer({
		ensureContact: async (input: any) => {
			ensuredInputs.push(input);
			return { ...baseContact, id: "ct_new", kind: "group", chatId: "g1" };
		},
	});
	const res = await server.callApi({
		type: "contacts:ensure",
		channelId: "ch_1",
		kind: "group",
		chatId: "g1",
	} as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("contacts:ensured");
	expect(body.contact.id).toBe("ct_new");
	expect(ensuredInputs).toEqual([{ channelId: "ch_1", kind: "group", chatId: "g1" }]);
});

test("contacts:ensure ensureContact 抛错 → HTTP 500 + err.message", async () => {
	const server = makeServer({
		ensureContact: async () => {
			throw new Error("存储 I/O 失败");
		},
	});
	const res = await server.callApi({
		type: "contacts:ensure",
		channelId: "ch_1",
		kind: "person",
		userId: "u1",
	} as any);
	expect(res.status).toBe(500);
	expect(((await res.json()) as any).error).toBe("存储 I/O 失败");
});

test("contacts:sync-wecom 成功 → broadcast contacts:changed + reply sync-wecom-result（返回 added/updated）", async () => {
	const server = makeServer({
		syncWecomContacts: async (channelId: string, keywords: string[]) => ({
			added: 2,
			updated: 1,
		}),
	});

	const broadcasted: any[] = [];
	const origBroadcast = server.broadcast.bind(server);
	server.broadcast = (e: any) => {
		broadcasted.push(e);
		origBroadcast(e);
	};

	const res = await server.callApi({
		type: "contacts:sync-wecom",
		channelId: "ch_1",
		keywords: ["张"],
	} as any);
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.type).toBe("contacts:sync-wecom-result");
	expect(body.added).toBe(2);
	expect(body.updated).toBe(1);
	expect(broadcasted.some((e) => e.type === "contacts:changed")).toBe(true);
});

test("contacts:sync-wecom channelManager 为 null → HTTP 400（通讯录未启用）", async () => {
	const server = makeServer(null);
	const res = await server.callApi({
		type: "contacts:sync-wecom",
		channelId: "ch_1",
		keywords: ["张"],
	} as any);
	expect(res.status).toBe(400);
	expect(((await res.json()) as any).error).toBe("通讯录未启用");
});

test("contacts:sync-wecom syncWecomContacts 抛错 → HTTP 500 + err.message", async () => {
	const server = makeServer({
		syncWecomContacts: async () => {
			throw new Error("该机器人不是企业微信机器人");
		},
	});
	const res = await server.callApi({
		type: "contacts:sync-wecom",
		channelId: "ch_1",
		keywords: ["张"],
	} as any);
	expect(res.status).toBe(500);
	expect(((await res.json()) as any).error).toBe("该机器人不是企业微信机器人");
});
