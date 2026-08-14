import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseChannelMentions,
	createRobotPushTool,
	type RobotPushToolDeps,
} from "../src/tools/robot-push";
import { ChannelManager } from "../src/channel-manager";
import { MockAdapter } from "../src/channels/mock-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

// ===== parseChannelMentions（纯函数）=====

describe("parseChannelMentions", () => {
	test("提取单个 @bot_xxx", () => {
		const prompt = "请把结果通过 @bot_abc123 推送给我";
		expect(parseChannelMentions(prompt)).toEqual(["bot_abc123"]);
	});

	test("提取多个 @bot_xxx", () => {
		const prompt = "通过 @bot_aaa 推送日报，@bot_bbb 推送周报";
		expect(parseChannelMentions(prompt)).toEqual(["bot_aaa", "bot_bbb"]);
	});

	test("无 @ 标记返回空数组", () => {
		const prompt = "请帮我整理文件";
		expect(parseChannelMentions(prompt)).toEqual([]);
	});

	test("去重", () => {
		const prompt = "@bot_aaa 先分析，再 @bot_aaa 推送";
		expect(parseChannelMentions(prompt)).toEqual(["bot_aaa"]);
	});

	test("不误匹配邮箱", () => {
		const prompt = "发邮件给 user@example.com";
		expect(parseChannelMentions(prompt)).toEqual([]);
	});

	test("bot ID 含连字符和下划线", () => {
		const prompt = "推送到 @bot_my-channel_01";
		expect(parseChannelMentions(prompt)).toEqual(["bot_my-channel_01"]);
	});

	test("不匹配纯 @ 开头非 bot_ 前缀", () => {
		const prompt = "@username 你好，@bot_real 来一下";
		expect(parseChannelMentions(prompt)).toEqual(["bot_real"]);
	});
});

// ===== createRobotPushTool（工具定义 + execute）=====

/** 最小 mock ChannelManager：只提供 pushToChannel，记录调用参数 */
function makeMockChannelManager(
	pushImpl: (channelId: string, message: string) => Promise<void>,
) {
	return { pushToChannel: mock(pushImpl) } as unknown as InstanceType<
		typeof ChannelManager
	>;
}

describe("createRobotPushTool: 工具定义", () => {
	test("name 和 description 正确，description 含可用渠道", () => {
		const deps: RobotPushToolDeps = {
			channelManager: makeMockChannelManager(async () => {}),
			availableChannelIds: ["bot_aaa", "bot_bbb"],
			onPushResult: () => {},
		};
		const tool = createRobotPushTool(deps);
		expect(tool.name).toBe("robot_push");
		expect(tool.description).toContain("bot_aaa");
		expect(tool.description).toContain("bot_bbb");
	});

	test("inputSchema.channel 的 enum 动态填充可用渠道", () => {
		const deps: RobotPushToolDeps = {
			channelManager: makeMockChannelManager(async () => {}),
			availableChannelIds: ["bot_x", "bot_y"],
			onPushResult: () => {},
		};
		const tool = createRobotPushTool(deps);
		expect(tool.inputSchema.properties.channel.enum).toEqual([
			"bot_x",
			"bot_y",
		]);
		expect(tool.inputSchema.required).toEqual(["channel", "message"]);
	});

	test("availableChannelIds 为空时 enum 仍为空数组", () => {
		const deps: RobotPushToolDeps = {
			channelManager: makeMockChannelManager(async () => {}),
			availableChannelIds: [],
			onPushResult: () => {},
		};
		const tool = createRobotPushTool(deps);
		expect(tool.inputSchema.properties.channel.enum).toEqual([]);
	});
});

describe("createRobotPushTool: execute", () => {
	test("推送成功 → 调用 channelManager.pushToChannel + onPushResult(success)", async () => {
		const pushToChannel = mock(async (_ch: string, _msg: string) => {});
		const results: { channelId: string; success: boolean; error?: string }[] =
			[];
		const deps: RobotPushToolDeps = {
			channelManager: { pushToChannel } as any,
			availableChannelIds: ["bot_aaa"],
			onPushResult: (r) => results.push(r),
		};
		const tool = createRobotPushTool(deps);
		const ret = await tool.execute({ channel: "bot_aaa", message: "日报" });
		expect(pushToChannel).toHaveBeenCalledTimes(1);
		expect(pushToChannel.mock.calls[0]).toEqual(["bot_aaa", "日报"]);
		expect(ret).toContain("已成功推送");
		expect(ret).toContain("bot_aaa");
		expect(results).toEqual([{ channelId: "bot_aaa", success: true }]);
	});

	test("渠道不在可用列表 → 不推送，返回错误", async () => {
		const pushToChannel = mock(async () => {});
		const deps: RobotPushToolDeps = {
			channelManager: { pushToChannel } as any,
			availableChannelIds: ["bot_aaa"],
			onPushResult: () => {},
		};
		const tool = createRobotPushTool(deps);
		const ret = await tool.execute({
			channel: "bot_unknown",
			message: "x",
		});
		expect(pushToChannel).not.toHaveBeenCalled();
		expect(ret).toContain("不在可用列表");
	});

	test("pushToChannel 抛错 → onPushResult(failure) + 返回错误信息", async () => {
		const results: { channelId: string; success: boolean; error?: string }[] =
			[];
		const deps: RobotPushToolDeps = {
			channelManager: makeMockChannelManager(async () => {
				throw new Error("渠道未连接");
			}),
			availableChannelIds: ["bot_aaa"],
			onPushResult: (r) => results.push(r),
		} as Pick<RobotPushToolDeps, "availableChannelIds"> & {
			channelManager: RobotPushToolDeps["channelManager"];
			onPushResult: (r: { channelId: string; success: boolean; error?: string }) => void;
		};
		const tool = createRobotPushTool(deps);
		const ret = await tool.execute({ channel: "bot_aaa", message: "hi" });
		expect(ret).toContain("推送失败");
		expect(ret).toContain("渠道未连接");
		expect(results).toHaveLength(1);
		expect(results[0].success).toBe(false);
		expect(results[0].error).toContain("渠道未连接");
	});
});

// ===== ChannelManager.pushToChannel（集成测试，真实 ChannelManager）=====

let dir: string;
let manager: ChannelManager;
let adapter: MockAdapter;

const baseChannel: Omit<ChannelConfig, "id" | "createdAt"> = {
	type: "mock",
	name: "测试推送机器人",
	enabled: true,
	credentials: { botId: "bot_test001", secret: "s" },
	agentName: "前端开发者",
	model: "p/m",
	extraSystemPrompt: "",
	replyGranularity: "standard",
	defaultProjectId: "__system__",
	allowProjectSwitch: false,
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-push-test-"));
	manager = new ChannelManager({
		channelsFile: join(dir, "channels.json"),
		mappingsFile: join(dir, "mappings.json"),
		tmpDir: join(dir, "tmp"),
		configStore: {
			listAgents: async () => [],
			getAgent: async () => null,
		} as any,
		projectStore: {
			load: async () => ({ projects: [], sessions: [] }),
			createSession: async () => ({ id: "x" }),
		} as any,
		agentManager: {} as any,
		broadcast: () => {},
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

describe("ChannelManager.pushToChannel", () => {
	test("成功推送：sendText 被调用，replyFrame=null（主动推送）", async () => {
		await manager.create(baseChannel);
		await manager.pushToChannel("bot_test001", "定时日报内容");
		expect(adapter!.outbox).toHaveLength(1);
		expect(adapter!.outbox[0].text).toBe("定时日报内容");
		// 主动推送无对应进站消息 → replyFrame 必须为 null
		expect(adapter!.outbox[0].replyFrame).toBeNull();
	});

	test("botId 不存在 → 抛错", async () => {
		await manager.create(baseChannel);
		await expect(manager.pushToChannel("bot_nobody", "x")).rejects.toThrow(
			"未连接",
		);
	});

	test("渠道未连接（adapter 未建立）→ 抛错", async () => {
		// create disabled 渠道 → adapter 不注册
		await manager.create({ ...baseChannel, enabled: false });
		await expect(manager.pushToChannel("bot_test001", "x")).rejects.toThrow(
			"未连接",
		);
	});
});
