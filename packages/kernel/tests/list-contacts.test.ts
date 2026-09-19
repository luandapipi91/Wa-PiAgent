import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	channelTypeLabel,
	contactLabelOf,
	createListContactsTool,
	formatContactsMarkdown,
} from "../src/tools/robot-push";
import type { ContactEntity } from "@wa-pi/shared";
import type { ListContactsToolDeps } from "../src/tools/robot-push";

/** 构造测试用联系人 */
function mkContact(
	overrides: Partial<ContactEntity> & { id: string },
): ContactEntity {
	return {
		channelId: "ch_wecom-1",
		kind: "person",
		userId: "u1",
		firstChatAt: 1,
		lastChatAt: 1,
		...overrides,
	};
}

/** 构造 fake channelManager（只提供 list_contacts 需要的两个方法） */
function fakeChannelManager(overrides?: {
	listContacts?: ListContactsToolDeps["channelManager"]["listContacts"];
	listWithStatus?: ListContactsToolDeps["channelManager"]["listWithStatus"];
}) {
	return {
		listContacts: overrides?.listContacts ?? (mock(async () => []) as any),
		listWithStatus: overrides?.listWithStatus ?? (mock(async () => []) as any),
	} as any;
}

// ===== contactLabelOf（名称回退规则，对齐前端 contactLabel）=====

describe("contactLabelOf：名称回退", () => {
	test("remark 优先", () => {
		expect(contactLabelOf(mkContact({ id: "ct_1", remark: "张三" }))).toBe(
			"张三",
		);
	});

	test("group 退 chatId 前 8 位", () => {
		expect(
			contactLabelOf(
				mkContact({
					id: "ct_2",
					kind: "group",
					chatId: "abcdefgh-123",
					userId: undefined,
				}),
			),
		).toBe("abcdefgh");
	});

	test("person 无 remark 退 userId", () => {
		expect(contactLabelOf(mkContact({ id: "ct_3", userId: "wangwu" }))).toBe(
			"wangwu",
		);
	});

	test("都缺 → 兜底 id", () => {
		expect(
			contactLabelOf(
				mkContact({
					id: "ct_4",
					userId: undefined,
					kind: "group",
					chatId: undefined,
				}),
			),
		).toBe("ct_4");
	});
});

// ===== formatContactsMarkdown（Markdown 生成）=====

describe("formatContactsMarkdown", () => {
	const contacts = [
		mkContact({ id: "ct_a1", remark: "张三", userId: "zhangsan" }),
		mkContact({
			id: "ct_b2",
			kind: "group",
			chatId: "abcdefgh-123",
			userId: undefined,
		}),
		mkContact({ id: "ct_c3", userId: "wangwu", channelId: "ch_wecom-2" }),
	];
	const channelMap = new Map<string, { type: string; name: string }>([
		["ch_wecom-1", { type: "wecom", name: "小 co" }],
		["ch_wecom-2", { type: "wecom", name: "企微-二" }],
	]);

	test("全部：标题带总数，每行含 id/名称/类型/所属渠道(类型名·机器人名)", () => {
		const md = formatContactsMarkdown(contacts, channelMap);
		expect(md).toContain("共 3 个");
		expect(md).toContain("| # | 联系人 ID | 名称 | 类型 | 所属渠道 |");
		expect(md).toContain("ct_a1");
		expect(md).toContain("张三");
		expect(md).toContain("企业微信 · 小 co");
		expect(md).toContain("ct_c3");
		expect(md).toContain("企业微信 · 企微-二");
	});

	test("渠道无法解析 → 回退显示 channelId", () => {
		const unknown = mkContact({
			id: "ct_d4",
			userId: "u",
			channelId: "ch_unknow",
		});
		const md = formatContactsMarkdown([unknown], channelMap);
		expect(md).toContain("ch_unknow");
	});

	test("带 channelId 标题携带渠道标识", () => {
		const md = formatContactsMarkdown(contacts, channelMap, "ch_wecom-1");
		expect(md).toContain("渠道 ch_wecom-1 的联系人（共 3 个）");
	});

	test("空列表 → 明确提示", () => {
		expect(formatContactsMarkdown([], channelMap)).toBe("当前没有可用联系人");
	});
});

// ===== channelTypeLabel（渠道类型 → 中文标签）=====

describe("channelTypeLabel", () => {
	test("wecom → 企业微信", () => {
		expect(channelTypeLabel("wecom")).toBe("企业微信");
	});
	test("wechat → 微信", () => {
		expect(channelTypeLabel("wechat")).toBe("微信");
	});
	test("feishu → 飞书", () => {
		expect(channelTypeLabel("feishu")).toBe("飞书");
	});
	test("qq → QQ", () => {
		expect(channelTypeLabel("qq")).toBe("QQ");
	});
	test("未知类型 → 回退原值", () => {
		expect(channelTypeLabel("custom")).toBe("custom");
	});
});

// ===== createListContactsTool（工具定义 + execute）=====

describe("createListContactsTool：工具定义", () => {
	test("名称为 list_contacts，参数为可选 channelId", () => {
		const tool = createListContactsTool({
			channelManager: fakeChannelManager(),
		});
		expect(tool.name).toBe("list_contacts");
		const props = (tool.inputSchema as any).properties;
		expect(props.channelId).toBeTruthy();
		expect((tool.inputSchema as any).required ?? []).toEqual([]);
	});
});

describe("createListContactsTool：execute", () => {
	test("无 channelId → 返回全部联系人 markdown", async () => {
		const contacts = [mkContact({ id: "ct_a1", remark: "张三" })];
		const tool = createListContactsTool({
			channelManager: fakeChannelManager({
				listContacts: mock(async () => contacts),
				listWithStatus: mock(async () => [
					{ id: "ch_wecom-1", type: "wecom", name: "小 co" },
				]),
			}),
		});
		const ret = await tool.execute({});
		expect(ret).toContain("共 1 个");
		expect(ret).toContain("张三");
		expect(ret).toContain("企业微信 · 小 co");
	});

	test("带 channelId → 透传给 listContacts", async () => {
		const listContacts = mock(async (channelId?: string) => {
			expect(channelId).toBe("ch_wecom-1");
			return [];
		});
		const tool = createListContactsTool({
			channelManager: fakeChannelManager({ listContacts }),
		});
		await tool.execute({ channelId: "ch_wecom-1" });
		expect(listContacts).toHaveBeenCalledWith("ch_wecom-1");
	});

	test("listContacts 抛错 → 返回失败文本（不抛出）", async () => {
		const tool = createListContactsTool({
			channelManager: fakeChannelManager({
				listContacts: mock(async () => {
					throw new Error("通讯录读取失败");
				}),
			}),
		});
		const ret = await tool.execute({});
		expect(ret).toContain("获取联系人失败：通讯录读取失败");
	});
});

// rmSync 兜底（node:fs 同步删除，顶部 import 的是 promise 版 rm）
import { rmSync } from "node:fs";
function rmSyncStub(f: string) {
	rmSync(f, { force: true });
}
void rmSyncStub;

// ===== C：handleTool 分发 list_contacts（会话注入 + 全局 executor）=====

import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { fakeClientFactory } from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { getBridgeSession } from "../src/bridge-registry";

describe("handleTool 分发 list_contacts", () => {
	const tmpFiles: string[] = [];
	const managers: AgentManager[] = [];

	afterEach(async () => {
		for (const am of managers.splice(0)) {
			await am.disposeAll().catch(() => {});
		}
		for (const f of tmpFiles.splice(0)) {
			try {
				rmSyncStub(f);
			} catch {
				/* 尽力清理 */
			}
		}
	});

	async function setupAgent(): Promise<{
		project: { id: string };
		session: { id: string };
		am: AgentManager;
	}> {
		const tmpFile = `/tmp/wa-pi-list-contacts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
		tmpFiles.push(tmpFile);
		const projectStore = new ProjectStore(tmpFile);
		const project = await projectStore.createProject({
			name: "测试",
			cwd: "/tmp",
		});
		const session = await projectStore.createSession({
			projectId: project.id,
			primaryAgent: "dev",
			title: "测试",
		});
		const am = new AgentManager({
			projectStore,
			configStore: null as any,
			onEvent: () => {},
			createClientFn: fakeClientFactory([]) as any,
			browserManager: NOOP_BROWSER_MANAGER,
		});
		managers.push(am);
		return { project: project as { id: string }, session, am };
	}

	test("arbitrary session calls list_contacts → via global executor (channelId passthrough)", async () => {
		const calls: Array<string | undefined> = [];
		const { project, session, am } = await setupAgent();
		am.setListContactsExecutor(async (channelId?: string) => {
			calls.push(channelId);
			return "## 渠道 clist 的联系人（共 1 个）";
		});
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		expect(ctx).toBeTruthy();
		const result = await ctx!.handleTool(
			"list_contacts",
			"tc-lc-1",
			{ channelId: "ch_wecom-1" },
			new AbortController().signal,
		);
		expect(calls).toEqual(["ch_wecom-1"]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "## 渠道 clist 的联系人（共 1 个）",
		});
	});

	test("未接线 executor → 返回明确错误（不崩溃）", async () => {
		const { project, session, am } = await setupAgent();
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"list_contacts",
			"tc-lc-2",
			{},
			new AbortController().signal,
		);
		expect((result.content[0] as { text: string }).text).toContain("未就绪");
		expect((result.details as { error?: string }).error).toBeTruthy();
	});

	test("executor 抛错 → 返回失败文本（不向 pi 进程抛异常）", async () => {
		const { project, session, am } = await setupAgent();
		am.setListContactsExecutor(async () => {
			throw new Error("通讯录读取失败");
		});
		await am.ensureStarted(project.id, "dev", session.id);
		const ctx = getBridgeSession(session.id);
		const result = await ctx!.handleTool(
			"list_contacts",
			"tc-lc-3",
			{},
			new AbortController().signal,
		);
		expect((result.content[0] as { text: string }).text).toBe(
			"获取联系人失败：通讯录读取失败",
		);
		expect((result.details as { error?: string }).error).toBe("通讯录读取失败");
	});
});
