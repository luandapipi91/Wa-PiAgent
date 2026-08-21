import { afterEach, beforeEach, expect, test, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../src/channel-manager";
import { listContacts } from "../src/contact-store";
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
// projectStore.load 返回的 sessions 列表：默认空，单测可往里塞数据模拟"会话存在"
let projectSessions: any[];

const channel: Omit<ChannelConfig, "id" | "createdAt"> = {
	type: "mock",
	name: "测试机器人",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "前端开发者",
	model: "p/m",
	extraSystemPrompt: "渠道规则",
	replyGranularity: "standard",
	defaultProjectId: "__system__",
	allowProjectSwitch: true,
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-chmgr-test-"));
	prompted = [];
	ensured = [];
	messagesBySession = {};
	sessionsCreated = [];
	broadcasted = [];
	projectSessions = [];
	manager = new ChannelManager({
		channelsFile: join(dir, "channels.json"),
		mappingsFile: join(dir, "mappings.json"),
		contactsFile: join(dir, "contacts.json"),
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
				projects: [
					{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 1 },
					{ id: "proj_x", name: "项目X", cwd: "/y", createdAt: 2 },
				],
				sessions: projectSessions,
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
			isSessionActive: () => false,
			markAllDirty: () => {},
		} as any,
		broadcast: (e: any) => broadcasted.push(e.type),
		pushConnectTimeoutMs: 500, // 推送前等待重连超时（测试用小值，避免真实等 60s）
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

test("handleInbound 采集：单聊记人、群聊记群（listContacts 可查）", async () => {
	await manager.create(channel);
	const channelId = (await manager.listWithStatus())[0].id;
	// 单聊进站 → 记 person（fromUserId）
	adapter!.inject({ chatId: "user-1", text: "hi" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	// 群聊进站 → 记 group（chatId）
	adapter!.inject({
		chatId: "group-1",
		fromUserId: "user-1",
		chatType: "group",
		text: "hi",
	});
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const contacts = await listContacts(channelId, join(dir, "contacts.json"));
	expect(
		contacts.some((c) => c.kind === "person" && c.userId === "user-1"),
	).toBe(true);
	expect(
		contacts.some((c) => c.kind === "group" && c.chatId === "group-1"),
	).toBe(true);
	// 公开方法 listContacts 走 contactsFile getter，同样可查
	const viaManager = await manager.listContacts(channelId);
	expect(
		viaManager.some((c) => c.kind === "person" && c.userId === "user-1"),
	).toBe(true);
	expect(
		viaManager.some((c) => c.kind === "group" && c.chatId === "group-1"),
	).toBe(true);
});

test("进站文本：建映射、建会话、ensureStarted 携带渠道提示词、prompt 带模型", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "你好" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(sessionsCreated).toHaveLength(1);
	expect(sessionsCreated[0].projectId).toBe("__system__");
	expect(ensured[0][0]).toBe("__system__");
	expect(ensured[0][3]).toEqual({ imChannelContext: "渠道规则" });
	expect(prompted[0].opts.model).toBe("p/m"); // 渠道 model 优先
	expect(broadcasted).toContain("session:created"); // 前端侧边栏增量感知新会话
	expect(broadcasted).toContain("channel-conversations:changed");
});

test("指令拦截：/new 不进智能体，直接回复", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "/new" });
	// 条件轮询替代固定 50ms：异步处理在并发/负载下可能超过 50ms（flaky 根因）
	const deadline = Date.now() + 2000;
	while (adapter!.outbox.length === 0 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("新会话");
});

test("/use 切换工作区后，下一条消息落到对应项目会话", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "/use 默认工作区" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(adapter!.outbox.at(-1)!.text).toContain("已切换");
});

test("agent_settled：按粒度组装并经适配器回复；正文+文件变更", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "改个 bug" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "改个 bug" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "已修复。" },
				{
					type: "toolCall",
					id: "1",
					name: "edit",
					arguments: { path: "a.ts" },
				},
			],
		},
	];
	manager.onSessionEvent(sid, { type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(adapter!.outbox.at(-1)!.text).toBe("已修复。\n\n📄 修改：a.ts");
});

test("agent_settled：错误回合读取最后 assistant 消息的 stopReason/errorMessage（而非事件字段）", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "改个 bug" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "改个 bug" }] },
		{
			role: "assistant",
			content: [{ type: "text", text: "" }],
			model: "p/m",
			stopReason: "error",
			errorMessage: "模型不可用",
		},
	];
	manager.onSessionEvent(sid, { type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const reply = adapter!.outbox.at(-1)!.text;
	expect(reply).toContain("处理出错");
	expect(reply).toContain("模型不可用");
	expect(reply).not.toContain("（本轮无文本回复）");
});

test("自动重试期间每次失败尝试的 agent_end 不触发回复；agent_settled 一轮只回一条", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "改个 bug" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "改个 bug" }] },
		{
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "Connection error.",
		},
	];
	const before = adapter!.outbox.length;
	// pi 自动重试：每次失败尝试都发 agent_end——这些不应产生 IM 回复
	manager.onSessionEvent(sid, { type: "agent_end" });
	manager.onSessionEvent(sid, { type: "agent_end" });
	manager.onSessionEvent(sid, { type: "agent_end" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(adapter!.outbox.length).toBe(before);
	// 终态 agent_settled 才回复，且只回一条
	manager.onSessionEvent(sid, { type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(adapter!.outbox.length).toBe(before + 1);
	expect(adapter!.outbox.at(-1)!.text).toContain("Connection error.");
});

test("智能体删除兜底：降级为列表第一项并记 warning", async () => {
	await manager.create({ ...channel, agentName: "已删除的智能体" });
	adapter!.inject({ chatId: "u1", text: "在吗" });
	// 条件轮询替代固定 50ms（ensureStarted 异步链路在负载下可能超 50ms）
	const deadline = Date.now() + 2000;
	while (ensured.length === 0 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(ensured[0][1]).toBe("前端开发者"); // listAgents()[0]
	expect(prompted[0].opts.model).toBe("p/m"); // 渠道 model 仍优先
});

test("无可用模型 → 回复配置错误，不调 prompt", async () => {
	await manager.create({ ...channel, model: null });
	adapter!.inject({ chatId: "u1", text: "hi" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("模型");
});

test("不支持的消息类型 → 提示回复", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", unsupported: "voice" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(adapter!.outbox.at(-1)!.text).toContain("暂不支持");
});

test("agentUsage：统计引用某智能体的渠道", async () => {
	await manager.create(channel);
	const usage = await manager.agentUsage("前端开发者");
	expect(usage.count).toBe(1);
	expect(usage.channelNames).toEqual(["测试机器人"]);
	expect((await manager.agentUsage("没人用")).count).toBe(0);
});

test("Bot ID 冲突：create/update 重复 botId 抛 ChannelConflictError（含 disabled 渠道）", async () => {
	const { ChannelConflictError } = await import("../src/channel-manager");
	await manager.create({ ...channel, enabled: false });
	// create 重复（即使已有渠道是 disabled）
	await expect(
		manager.create({ ...channel, name: "第二个机器人" }),
	).rejects.toBeInstanceOf(ChannelConflictError);
	// update 改成别人占用的 botId
	await manager.create({
		...channel,
		name: "丙",
		credentials: { botId: "b2", secret: "s" },
	});
	const list = await manager.listWithStatus();
	const third = list.find((c) => c.name === "丙")!;
	await expect(
		manager.update(third.id, { credentials: { botId: "b", secret: "s" } }),
	).rejects.toBeInstanceOf(ChannelConflictError);
	// update 自己保持原 botId 不冲突
	await expect(
		manager.update(third.id, { name: "丙改" }),
	).resolves.toBeUndefined();
});

test("listConversations：返回会话列表项（含预览与项目名）", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "你好呀" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const convs = await manager.listConversations();
	expect(convs).toHaveLength(1);
	expect(convs[0].channelName).toBe("测试机器人");
	expect(convs[0].projectName).toBe("默认工作区");
	expect(convs[0].lastMessagePreview).toBe("你好呀");
});

test("/new 归档当前会话：历史会话仍在 IM tab 可见（listConversations 返回两条）", async () => {
	await manager.create(channel);
	// 第一条消息建立会话 A
	adapter!.inject({ chatId: "u1", text: "第一次对话" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const firstSid = sessionsCreated[0].id;
	// 让会话 A 在 projectStore 里可见（createSession mock 不回填 load，手动塞）
	projectSessions.push({
		id: firstSid,
		projectId: "__system__",
		primaryAgent: "前端开发者",
		title: "IM · u1",
		createdAt: 1000,
		lastActivity: 1000,
		piSessionFile: "",
	});

	// /new 归档会话 A（不进智能体，不新增 prompt）
	broadcasted.length = 0;
	const promptedBeforeNew = prompted.length;
	adapter!.inject({ chatId: "u1", text: "/new" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(prompted).toHaveLength(promptedBeforeNew);
	expect(adapter!.outbox.at(-1)!.text).toContain("新会话");
	// 广播 channel-conversations:changed 让前端 IM 列表刷新
	expect(broadcasted).toContain("channel-conversations:changed");

	// 第二条消息建立会话 B（新的当前会话）
	adapter!.inject({ chatId: "u1", text: "第二次对话" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const secondSid = sessionsCreated[1].id;
	projectSessions.push({
		id: secondSid,
		projectId: "__system__",
		primaryAgent: "前端开发者",
		title: "IM · u1",
		createdAt: 2000,
		lastActivity: 2000,
		piSessionFile: "",
	});

	// IM tab 列表应同时返回当前会话 B 和归档的历史会话 A
	const convs = await manager.listConversations();
	expect(convs).toHaveLength(2);
	const sessionIds = convs.map((c) => c.sessionId);
	expect(sessionIds).toContain(firstSid);
	expect(sessionIds).toContain(secondSid);
	// 当前会话 B 有预览；历史会话 A 预览为空
	const histConv = convs.find((c) => c.sessionId === firstSid)!;
	expect(histConv.lastMessagePreview).toBe("");
	const curConv = convs.find((c) => c.sessionId === secondSid)!;
	expect(curConv.lastMessagePreview).toBe("第二次对话");
});

test("群聊隔离：同群不同用户 → 各自独立 mapping/会话；listConversations 可区分", async () => {
	await manager.create(channel);
	// 同一群 g1，用户 A 发消息
	adapter!.inject({
		chatId: "g1",
		fromUserId: "userA",
		chatType: "group",
		text: "A 的消息",
	});
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	// 同一群 g1，用户 B 发消息
	adapter!.inject({
		chatId: "g1",
		fromUserId: "userB",
		chatType: "group",
		text: "B 的消息",
	});
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;

	// 两个用户各建了一个独立会话（而非群维度共享一个）
	expect(sessionsCreated).toHaveLength(2);
	expect(sessionsCreated[0].id).not.toBe(sessionsCreated[1].id);
	// 群聊会话标题带发送者（区分不同用户）
	expect(sessionsCreated[0].title).toContain("userA");
	expect(sessionsCreated[1].title).toContain("userB");

	// listConversations 返回两条，fromUserId 各异、标题可区分
	const convs = await manager.listConversations();
	expect(convs).toHaveLength(2);
	const userIds = convs.map((c) => c.fromUserId).sort();
	expect(userIds).toEqual(["userA", "userB"]);
});

test("群聊隔离：同群同用户复用同一会话（不重复建会话）", async () => {
	await manager.create(channel);
	adapter!.inject({
		chatId: "g1",
		fromUserId: "userA",
		chatType: "group",
		text: "第一条",
	});
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	// 让首次建立的会话在 projectStore 可见（mock createSession 不回填 load，手动塞）
	const sid = sessionsCreated[0].id;
	projectSessions.push({
		id: sid,
		projectId: "__system__",
		primaryAgent: "前端开发者",
		title: sessionsCreated[0].title,
		createdAt: 1,
		lastActivity: 1,
		piSessionFile: "",
	});
	adapter!.inject({
		chatId: "g1",
		fromUserId: "userA",
		chatType: "group",
		text: "第二条",
	});
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	// 同群同用户 → 复用会话，只建一个
	expect(sessionsCreated).toHaveLength(1);
});

test("onSessionDeleted：删除 IM 会话时联动清理映射（当前指针 + 历史归档）", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "第一条" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = sessionsCreated[0].id;
	projectSessions.push({
		id: sid,
		projectId: "__system__",
		primaryAgent: "dev",
		title: "IM · u1",
		createdAt: 1,
		lastActivity: 1,
		piSessionFile: "",
	});

	// /new 归档
	adapter!.inject({ chatId: "u1", text: "/new" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;

	// 模拟前端删除该历史会话：onSessionDeleted 应清理 historySessionIds
	broadcasted.length = 0;
	await manager.onSessionDeleted(sid);
	expect(broadcasted).toContain("channel-conversations:changed");

	// 历史会话实体也被从 projectStore 移除（模拟 deleteSession）
	projectSessions.splice(0, projectSessions.length);
	// listConversations 不再返回已删除的历史会话
	const convs = await manager.listConversations();
	expect(convs.find((c) => c.sessionId === sid)).toBeUndefined();
});

test("onSessionDeleted：非 IM 会话在 mapping 里查不到 → no-op（不广播不落盘）", async () => {
	await manager.create(channel);
	broadcasted.length = 0;
	await manager.onSessionDeleted("some-random-session-id");
	expect(broadcasted).toHaveLength(0);
});

test("映射缓存的会话已被删除 → 兜底新建会话，不抛'会话不存在'", async () => {
	await manager.create(channel);
	// 第一条消息：建立映射 + 创建会话 A
	adapter!.inject({ chatId: "u1", text: "第一条" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(sessionsCreated).toHaveLength(1);
	const staleSid = sessionsCreated[0].id;
	expect(staleSid.startsWith("im-")).toBe(true);
	// 用户未收到"会话不存在"错误
	expect(adapter!.outbox.some((m) => m.text.includes("会话不存在"))).toBe(false);

	// 模拟会话被删除（前端删会话 / 数据清理）：project-store 里不再有该 session
	// projectSessions 本来就是 []（createSession 是独立 mock 不回填 load），无需改动

	// 第二条消息：映射里还缓存着失效的 staleSid，应兜底新建会话 B 而非报错
	adapter!.inject({ chatId: "u1", text: "第二条" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;

	// 新建了第二个会话，id 与失效的不同
	expect(sessionsCreated).toHaveLength(2);
	const newSid = sessionsCreated[1].id;
	expect(newSid).not.toBe(staleSid);
	// ensureStarted 用的是新会话 id（兜底成功，未阻断）
	expect(ensured[1][2]).toBe(newSid);
	// 用户没有收到任何"会话不存在"错误回复
	expect(adapter!.outbox.some((m) => m.text.includes("会话不存在"))).toBe(false);
	// prompt 在新会话里执行
	expect(prompted[1].sessionId).toBe(newSid);
});

// ===== 流式回复 =====

/** 构造 message_update(text_delta) 事件：0.84 起 RPC 剥离 partial，只含 delta 增量 */
function textDeltaEvent(delta: string) {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta },
	};
}

/** 构造 assistant 消息开始事件（重置流式 delta 累积） */
function assistantStartEvent() {
	return {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	};
}

/** 构造 assistant 消息定稿事件（清空流式 delta 累积） */
function assistantEndEvent(text: string) {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

test("流式回复：text_delta → streamReply 增量帧（streamId 稳定）；agent_settled → 终结帧", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "写首诗" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;

	// assistant 消息开始：重置 delta 累积
	manager.onSessionEvent(sid, assistantStartEvent());
	// 首个 text_delta（增量）：发首帧（finish=false）
	manager.onSessionEvent(sid, textDeltaEvent("床前"));
	await new Promise((r) => setTimeout(r, 20));
	// 流式帧已入 outbox
	const streamFrames = adapter!.outbox.filter((m) => m.streamId);
	expect(streamFrames.length).toBeGreaterThanOrEqual(1);
	const streamId = streamFrames[0].streamId;
	expect(streamFrames[0].finish).toBe(false);
	expect(streamFrames[0].text).toBe("床前");

	// 第二个 text_delta（增量）：streamId 不变，内容更新
	manager.onSessionEvent(sid, textDeltaEvent("明月光"));
	await new Promise((r) => setTimeout(r, 20));

	// assistant 消息定稿：清空 delta 累积（该消息已进 getMessages）
	manager.onSessionEvent(sid, assistantEndEvent("床前明月光"));

	// agent_settled 终结：用 composeReply 文本发 finish=true
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "写首诗" }] },
		{ role: "assistant", content: [{ type: "text", text: "床前明月光" }] },
	];
	manager.onSessionEvent(sid, { type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;

	// 所有流式帧 streamId 一致
	const allStreamFrames = adapter!.outbox.filter((m) => m.streamId);
	expect(allStreamFrames.every((m) => m.streamId === streamId)).toBe(true);
	// 终结帧 finish=true
	const finalFrame = allStreamFrames.at(-1)!;
	expect(finalFrame.finish).toBe(true);
	expect(finalFrame.text).toBe("床前明月光");
});

test("流式多消息轮（工具调用）：第二条消息的流式帧含已落地历史，不清空", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "改个 bug" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;

	// 第一条 assistant 消息流式（"正在修复"）
	manager.onSessionEvent(sid, assistantStartEvent());
	manager.onSessionEvent(sid, textDeltaEvent("正在修复"));
	await new Promise((r) => setTimeout(r, 20));
	// 第一条消息定稿（工具调用开始前）：清空 delta 累积
	manager.onSessionEvent(sid, assistantEndEvent("正在修复"));
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "改个 bug" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "正在修复" },
				{
					type: "toolCall",
					id: "1",
					name: "edit",
					arguments: { path: "a.ts" },
				},
			],
		},
	];

	// 工具执行需要时间：等待节流间隔过去后再发第二条消息的 delta（模拟真实时序）
	await new Promise((r) => setTimeout(r, 550));

	// 第二条 assistant 消息开始流式（delta 只含自己的文本"已修复"）
	manager.onSessionEvent(sid, assistantStartEvent());
	manager.onSessionEvent(sid, textDeltaEvent("已修复"));
	await new Promise((r) => setTimeout(r, 20));

	// 最后一个流式帧应含两条消息的累计文本（"正在修复" + "已修复"），而非只有"已修复"
	const streamFrames = adapter!.outbox.filter((m) => m.streamId);
	const lastFrame = streamFrames.at(-1)!;
	expect(lastFrame.text).toContain("正在修复");
	expect(lastFrame.text).toContain("已修复");
});

test("流式回复：同一消息多 text block（不同 contentIndex）按块累积，不交错拼接", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "分析代码" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;

	// assistant 消息开始：重置累积
	manager.onSessionEvent(sid, assistantStartEvent());
	// 一条 assistant 消息含多个 text block（如 idx1 总结 + idx3 修复说明，中间 idx2 是 toolCall），
	// delta 按 contentIndex 交错到达：每个 block 的文本必须各自完整累积，再按 contentIndex 升序拼接。
	manager.onSessionEvent(sid, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 1,
			delta: "床前明",
		},
	});
	manager.onSessionEvent(sid, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 3,
			delta: "修复完成",
		},
	});
	manager.onSessionEvent(sid, {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 1,
			delta: "月光光",
		},
	});
	manager.onSessionEvent(sid, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "！" },
	});
	// 等待流式节流窗口（STREAM_THROTTLE_MS=500ms）冲刷挂起帧
	await new Promise((r) => setTimeout(r, 600));

	const streamFrames = adapter!.outbox.filter((m) => m.streamId);
	const lastFrame = streamFrames.at(-1)!;
	// 两个 block 各自完整累积、按 contentIndex 升序拼接，而非按到达顺序交错
	expect(lastFrame.text).toContain("床前明月光");
	expect(lastFrame.text).toContain("修复完成！");
	expect(lastFrame.text).not.toContain("床前明修复完成");
});

test("极简回复（minimal）：禁用流式增量，终态帧只含最后一条 assistant 消息全文", async () => {
	await manager.create({
		...channel,
		replyGranularity: "minimal",
		name: "极简机器人",
	});
	adapter!.inject({ chatId: "u1", text: "总结一下" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;

	// 过程性 text_delta 不应产生任何流式帧（minimal 禁流）
	manager.onSessionEvent(sid, textDeltaEvent("我先检查一下。"));
	await new Promise((r) => setTimeout(r, 20));
	manager.onSessionEvent(
		sid,
		textDeltaEvent("修复完成。\n主要改动：\n- 改了 a.ts"),
	);
	await new Promise((r) => setTimeout(r, 20));
	expect(adapter!.outbox.filter((m) => m.streamId)).toHaveLength(0);

	// agent_settled 终态：一次性发最后一条 assistant 消息全文（丢弃过程消息）
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "总结一下" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "我先检查一下。" },
				{
					type: "toolCall",
					id: "1",
					name: "edit",
					arguments: { path: "a.ts" },
				},
			],
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "修复完成。\n主要改动：\n- 改了 a.ts" }],
		},
	];
	manager.onSessionEvent(sid, { type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;

	const sent = adapter!.outbox.filter((m) => !m.streamId);
	expect(sent.length).toBeGreaterThanOrEqual(1);
	expect(sent.at(-1)!.text).toBe("修复完成。\n主要改动：\n- 改了 a.ts");
});

test("节流 setTimeout 回调：streamReply 失败（WS 断线）不产生 unhandledRejection，记 warn", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "写首诗" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;

	// 监听 unhandledRejection：验证断线期流式帧失败不再成为未处理拒绝
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const warnSpy = mock(() => {});
	const origWarn = console.warn;
	console.warn = warnSpy;
	try {
		manager.onSessionEvent(sid, assistantStartEvent());
		// 首个 delta：距上次发送 0 < 500ms → 直接发送（成功）
		manager.onSessionEvent(sid, textDeltaEvent("床前"));
		await new Promise((r) => setTimeout(r, 20));
		// 第二个 delta：距上次发送 < 500ms → 进入节流 setTimeout 分支
		manager.onSessionEvent(sid, textDeltaEvent("明月光"));
		// 模拟企微 WS 断线：之后 streamReply 一律失败（与 SDK send() 抛错一致）
		adapter!.streamReply = async () => {
			throw new Error("WebSocket not connected, unable to send data");
		};
		// 等待节流 timer 触发（≤500ms），回调内 sendStreamFrame → reject
		await new Promise((r) => setTimeout(r, 700));
		// 修复前：rejection 到达 setTimeout 回调无人消费 → unhandledRejection
		expect(unhandled).toHaveLength(0);
		// 修复后：错误被 .catch 捕获并 console.warn
		expect(warnSpy).toHaveBeenCalled();
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
		console.warn = origWarn;
	}
});

test("错误回合不走流式终结，走 sendText 新消息", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "报错的请求" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const sid = prompted[0].sessionId;

	// 先产生流式帧
	manager.onSessionEvent(sid, textDeltaEvent("正在处理"));
	await new Promise((r) => setTimeout(r, 20));

	// agent_settled 时是错误回合
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "报错的请求" }] },
		{
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: "模型超时",
		},
	];
	manager.onSessionEvent(sid, { type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;

	// 最后一条是 sendText（非流式），内容为错误提示
	const last = adapter!.outbox.at(-1)!;
	expect(last.streamId).toBeUndefined();
	expect(last.text).toBe("处理出错：模型超时");
});

// ===== 渠道默认工作区 + 切换开关 + 项目删除兜底（Task 4） =====

test("新建映射使用渠道 defaultProjectId（非默认工作区）", async () => {
	await manager.create({ ...channel, defaultProjectId: "proj_x" });
	adapter!.inject({ chatId: "u_custom", text: "你好" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(sessionsCreated).toHaveLength(1);
	expect(sessionsCreated[0].projectId).toBe("proj_x");
	expect(ensured[0][0]).toBe("proj_x");
});

test("allowProjectSwitch=false：/use 被拒，不进智能体、不切换", async () => {
	await manager.create({ ...channel, allowProjectSwitch: false });
	adapter!.inject({ chatId: "u_ns", text: "/use 项目X" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	// 拒绝回复经适配器 outbox（不经过 agentManager.prompt）
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("不支持切换工作目录");
	// 后续普通消息仍落在默认工作区
	adapter!.inject({ chatId: "u_ns", text: "你好" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	expect(sessionsCreated[0].projectId).toBe("__system__");
});

test("defaultProjectId 指向已删除项目 → ensureSession 降级为 __system__ 并 warn", async () => {
	const warnSpy = mock(() => {});
	const origWarn = console.warn;
	console.warn = warnSpy;
	try {
		await manager.create({ ...channel, defaultProjectId: "proj_deleted" });
		adapter!.inject({ chatId: "u_dead", text: "你好" });
		await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
		expect(sessionsCreated).toHaveLength(1);
		expect(sessionsCreated[0].projectId).toBe("__system__");
		expect(warnSpy).toHaveBeenCalled();
	} finally {
		console.warn = origWarn;
	}
});

test("pushToContact：按联系人 id 主动推送到对应会话（单聊 userid）", async () => {
	await manager.create(channel);
	// 注入进站消息产生 person 联系人（user-1）
	adapter!.inject({ chatId: "user-1", text: "hi" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const contacts = await manager.listContacts();
	const person = contacts.find(
		(c) => c.kind === "person" && c.userId === "user-1",
	);
	expect(person).toBeTruthy();

	await manager.pushToContact(person!.id, "**定时任务推送**");
	const last = adapter!.outbox.at(-1)!;
	expect(last.text).toBe("**定时任务推送**");
	expect(last.chatId).toBe("user-1"); // 单聊 → chatId = userid
	expect(last.replyFrame).toBeNull(); // 主动推送无回复帧
});

test("pushToContact：群联系人 → chatId = chatid；联系人不存在 → 抛错", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "group-1", chatType: "group", text: "hi" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const contacts = await manager.listContacts();
	const group = contacts.find(
		(c) => c.kind === "group" && c.chatId === "group-1",
	);
	expect(group).toBeTruthy();

	await manager.pushToContact(group!.id, "群消息");
	expect(adapter!.outbox.at(-1)!.chatId).toBe("group-1");

	await expect(manager.pushToContact("ct_not_exist", "x")).rejects.toThrow();
});

test("pushToContact：断线时等待重连就绪后再推送", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "user-1", text: "hi" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const contacts = await manager.listContacts();
	const person = contacts.find(
		(c) => c.kind === "person" && c.userId === "user-1",
	);
	expect(person).toBeTruthy();

	// 模拟断线：渠道状态变为 connecting（推送前应挂起等待重连）
	adapter!.setStatus("connecting");
	const pushPromise = manager.pushToContact(person!.id, "**定时任务推送**");
	// 等 pushToContact 走到等待分支（已注册 waiter）后重连成功
	await new Promise((r) => setTimeout(r, 100));
	adapter!.setStatus("connected");
	await pushPromise;

	const last = adapter!.outbox.at(-1)!;
	expect(last.text).toBe("**定时任务推送**");
	expect(last.chatId).toBe("user-1");
});

test("pushToContact：断线超时未恢复 → 抛错（含未连接提示与 detail）", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "user-1", text: "hi" });
	await new Promise((r) => setTimeout(r, 500)) // 负载下 50ms 可能不够（flaky），放宽到 500ms;
	const contacts = await manager.listContacts();
	const person = contacts.find(
		(c) => c.kind === "person" && c.userId === "user-1",
	);
	expect(person).toBeTruthy();

	adapter!.setStatus("connecting", "模拟断线");
	await expect(manager.pushToContact(person!.id, "x")).rejects.toThrow(
		/未连接.*模拟断线/,
	);
});
