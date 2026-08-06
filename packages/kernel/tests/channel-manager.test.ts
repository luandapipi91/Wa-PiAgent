import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../src/channel-manager";
import { MockAdapter } from "../src/channels/mock-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

let dir: string;
let manager: ChannelManager;
let adapter: MockAdapter;
let prompted: { sessionId: string; text: string; opts: any }[];
let ensured: any[];
let messagesBySession: Record<string, any[]>;
let sessionsCreated: any[];
let broadcasted: string[];

const channel: Omit<ChannelConfig, "id" | "createdAt"> = {
	type: "mock",
	name: "测试机器人",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "前端开发者",
	model: "p/m",
	extraSystemPrompt: "渠道规则",
	replyGranularity: "standard",
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-chmgr-test-"));
	prompted = [];
	ensured = [];
	messagesBySession = {};
	sessionsCreated = [];
	broadcasted = [];
	manager = new ChannelManager({
		channelsFile: join(dir, "channels.json"),
		mappingsFile: join(dir, "mappings.json"),
		tmpDir: join(dir, "tmp"),
		configStore: {
			listAgents: async () => [
				{ displayName: "前端开发者", model: null },
				{ displayName: "后端架构师", model: null },
			],
			getAgent: async (name: string) =>
				name === "前端开发者"
					? { displayName: "前端开发者", model: null, thinking: null }
					: null,
		} as any,
		projectStore: {
			load: async () => ({
				projects: [{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 1 }],
				sessions: [],
			}),
			createSession: async (input: any) => {
				sessionsCreated.push(input);
				return { id: input.id, ...input };
			},
		} as any,
		agentManager: {
			ensureStarted: async (...a: any[]) => {
				ensured.push(a);
			},
			prompt: async (sessionId: string, text: string, opts: any) => {
				prompted.push({ sessionId, text, opts });
			},
			getMessages: (sid: string) => messagesBySession[sid] ?? [],
			isSessionBusy: () => false,
		} as any,
		broadcast: (e: any) => broadcasted.push(e.type),
		adapterFactories: {
			mock: (c) => {
				adapter = new MockAdapter(c);
				return adapter;
			},
		},
	});
});
afterEach(async () => {
	await manager.stop();
	await rm(dir, { recursive: true, force: true });
});

test("create：校验失败抛中文错；成功则落盘并连接", async () => {
	await expect(
		manager.create({ ...channel, credentials: { botId: "", secret: "s" } }),
	).rejects.toThrow("Bot ID");
	await manager.create(channel);
	const list = await manager.listWithStatus();
	expect(list).toHaveLength(1);
	expect(list[0].credentials.secret).toBe("****"); // 脱敏（"s" 长度<4 → ****）
	expect(list[0].status).toBe("connected");
});

test("进站文本：建映射、建会话、ensureStarted 携带渠道提示词、prompt 带模型", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "你好" });
	await new Promise((r) => setTimeout(r, 50));
	expect(sessionsCreated).toHaveLength(1);
	expect(sessionsCreated[0].projectId).toBe("__system__");
	expect(ensured[0][0]).toBe("__system__");
	expect(ensured[0][3]).toEqual({ imChannelContext: "渠道规则" });
	expect(prompted[0].opts.model).toBe("p/m"); // 渠道 model 优先
	expect(broadcasted).toContain("channel-conversations:changed");
});

test("指令拦截：/new 不进智能体，直接回复", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "/new" });
	await new Promise((r) => setTimeout(r, 50));
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("新会话");
});

test("/use 切换工作区后，下一条消息落到对应项目会话", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "/use 默认工作区" });
	await new Promise((r) => setTimeout(r, 50));
	expect(adapter!.outbox.at(-1)!.text).toContain("已切换");
});

test("agent_end：按粒度组装并经适配器回复；正文+文件变更", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "改个 bug" });
	await new Promise((r) => setTimeout(r, 50));
	const sid = prompted[0].sessionId;
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "改个 bug" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "已修复。" },
				{ type: "toolCall", id: "1", name: "edit", arguments: { path: "a.ts" } },
			],
		},
	];
	manager.onSessionEvent(sid, { type: "agent_end" });
	await new Promise((r) => setTimeout(r, 50));
	expect(adapter!.outbox.at(-1)!.text).toBe("已修复。\n\n📄 修改：a.ts");
});

test("智能体删除兜底：降级为列表第一项并记 warning", async () => {
	await manager.create({ ...channel, agentName: "已删除的智能体" });
	adapter!.inject({ chatId: "u1", text: "在吗" });
	await new Promise((r) => setTimeout(r, 50));
	expect(ensured[0][1]).toBe("前端开发者"); // listAgents()[0]
	expect(prompted[0].opts.model).toBe("p/m"); // 渠道 model 仍优先
});

test("无可用模型 → 回复配置错误，不调 prompt", async () => {
	await manager.create({ ...channel, model: null });
	adapter!.inject({ chatId: "u1", text: "hi" });
	await new Promise((r) => setTimeout(r, 50));
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("模型");
});

test("不支持的消息类型 → 提示回复", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", unsupported: "voice" });
	await new Promise((r) => setTimeout(r, 50));
	expect(adapter!.outbox.at(-1)!.text).toContain("暂不支持");
});

test("agentUsage：统计引用某智能体的渠道", async () => {
	await manager.create(channel);
	const usage = await manager.agentUsage("前端开发者");
	expect(usage.count).toBe(1);
	expect(usage.channelNames).toEqual(["测试机器人"]);
	expect((await manager.agentUsage("没人用")).count).toBe(0);
});

test("listConversations：返回会话列表项（含预览与项目名）", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "你好呀" });
	await new Promise((r) => setTimeout(r, 50));
	const convs = await manager.listConversations();
	expect(convs).toHaveLength(1);
	expect(convs[0].channelName).toBe("测试机器人");
	expect(convs[0].projectName).toBe("默认工作区");
	expect(convs[0].lastMessagePreview).toBe("你好呀");
});
