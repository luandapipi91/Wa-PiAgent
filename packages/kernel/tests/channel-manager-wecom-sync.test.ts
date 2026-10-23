// ChannelManager.syncWecomContacts 语义：
// - 非 wecom 渠道 → 抛错「该机器人不是企业微信机器人」
// - 缺 botId/secret → 抛错
// - 调 WecomCliClient.searchContacts(keywords, "list") 搜索成员
// - 每个成员 ensureContact(kind=person, userId=userid) 建/取联系人
// - remark 为空且成员有姓名 → renameContact 填姓名（不覆盖已有手动备注）
// - 返回 { added, updated }：added=新创建数，updated=补写姓名数
// 测试通过 deps.wecomCliFactory 注入 fake，不用 mock.module（进程级全局且不可撤销）
import { afterEach, beforeEach, expect, test, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../src/channel-manager";
import { listContacts, renameContact } from "../src/contact-store";
import type { WecomContactUser } from "../src/channels/wecom-cli-client";
import type { ChannelConfig } from "@wa-pi/shared";

let dir: string;
let manager: ChannelManager;
let searchContacts: ReturnType<typeof mock>;
let broadcasted: string[];
let channelId: string; // create 生成的随机 id（ch_xxxx），由 beforeEach 读取

const wecomChannel: Omit<ChannelConfig, "id" | "createdAt"> = {
	type: "wecom",
	name: "企微机器人",
	enabled: true,
	credentials: { botId: "bot_wecom", secret: "sec_wecom" },
	agentName: "前端开发者",
	model: "p/m",
	extraSystemPrompt: "",
	replyGranularity: "standard",
	defaultProjectId: "__system__",
	allowProjectSwitch: false,
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-wecom-sync-"));
	broadcasted = [];
	searchContacts = mock(async () => [] as WecomContactUser[]);
	manager = new ChannelManager({
		channelsFile: join(dir, "channels.json"),
		mappingsFile: join(dir, "mappings.json"),
		contactsFile: join(dir, "contacts.json"),
		tmpDir: join(dir, "tmp"),
		configStore: {
			listAgents: async () => [],
			getAgent: async () => null,
		} as any,
		projectStore: {
			load: async () => ({ projects: [], sessions: [] }),
			createSession: async (input: any) => ({ id: input.id, ...input }),
		} as any,
		agentManager: {} as any,
		broadcast: (e: any) => broadcasted.push(e.type),
		wecomCliFactory: () => ({ searchContacts }),
	} as any);
	await manager.create({ ...wecomChannel });
	const { loadChannels } = await import("../src/channel-store");
	channelId = (await loadChannels(join(dir, "channels.json")))[0].id;
});

afterEach(async () => {
	await manager.stop();
	await rm(dir, { recursive: true, force: true });
});

function makeUser(userid: string, name: string): WecomContactUser {
	return { userid, name, position: "测试", departments: ["七圣/测试组"] };
}

test("非 wecom 渠道 → 抛错", async () => {
	await expect(manager.syncWecomContacts("not_exist", ["张"])).rejects.toThrow(
		/不是企业微信机器人/,
	);
});

test("搜索成员 → 每个成员建联系人并填姓名，返回 added/updated", async () => {
	searchContacts.mockResolvedValue([
		makeUser("u1", "张文明"),
		makeUser("u2", "张惠梅"),
	]);
	const result = await manager.syncWecomContacts(channelId, ["张"]);
	expect(result).toEqual({ added: 2, updated: 2 });
	// searchContacts 以 list 模式调用
	expect(searchContacts).toHaveBeenCalledWith(["张"], "list");
	// 联系人落盘：kind=person + userId + remark=姓名
	const contacts = await listContacts(undefined, join(dir, "contacts.json"));
	expect(contacts).toHaveLength(2);
	const u1 = contacts.find((c) => c.userId === "u1")!;
	expect(u1.kind).toBe("person");
	expect(u1.remark).toBe("张文明");
});

test("再次同步同批成员 → 不重复新增，返回 added=0", async () => {
	searchContacts.mockResolvedValue([makeUser("u1", "张文明")]);
	await manager.syncWecomContacts(channelId, ["张"]);
	const result = await manager.syncWecomContacts(channelId, ["张"]);
	expect(result.added).toBe(0);
	expect(result.updated).toBe(0); // remark 已有，不覆盖
});

test("已有手动备注 → 同步不覆盖 remark", async () => {
	searchContacts.mockResolvedValue([makeUser("u1", "张文明")]);
	await manager.syncWecomContacts(channelId, ["张"]);
	// 用户手动重命名
	const contacts = await listContacts(undefined, join(dir, "contacts.json"));
	await renameContact(contacts[0].id, "张总", join(dir, "contacts.json"));
	// 再次同步
	const result = await manager.syncWecomContacts(channelId, ["张"]);
	expect(result.updated).toBe(0);
	const after = await listContacts(undefined, join(dir, "contacts.json"));
	expect(after[0].remark).toBe("张总"); // 手动备注保留
});

test("搜索接口抛错 → 透传错误", async () => {
	searchContacts.mockRejectedValue(new Error("通讯录搜索失败"));
	await expect(manager.syncWecomContacts(channelId, ["张"])).rejects.toThrow(
		/通讯录搜索失败/,
	);
});
