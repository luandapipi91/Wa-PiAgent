import { expect, mock, test } from "bun:test";
import { WecomAdapter, normalizeInbound } from "../src/channels/wecom-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

const channel = {
	id: "ch_1",
	type: "wecom",
	name: "企微",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "a",
	model: null,
	extraSystemPrompt: "",
	replyGranularity: "standard",
	defaultProjectId: "__system__",
	allowProjectSwitch: false,
	createdAt: 1,
} satisfies ChannelConfig;

test("单聊文本：chatId=userid，原样保留文本", () => {
	const msg = normalizeInbound({
		headers: { req_id: "r1" },
		body: {
			msgid: "m1",
			chattype: "single",
			from: { userid: "zhangsan" },
			msgtype: "text",
			text: { content: "你好" },
		},
	});
	expect(msg).toMatchObject({
		chatId: "zhangsan",
		chatType: "single",
		text: "你好",
		msgId: "m1",
	});
});

test("群聊文本：chatId=群id，剥离 @机器人 前缀", () => {
	const msg = normalizeInbound({
		headers: { req_id: "r2" },
		body: {
			msgid: "m2",
			chattype: "group",
			chatid: "wr_abc",
			from: { userid: "zhangsan" },
			msgtype: "text",
			text: { content: "@客服机器人 在吗" },
		},
	});
	expect(msg!.chatId).toBe("wr_abc");
	expect(msg!.text).toBe("在吗");
});

test("pushMessage：SDK reject 帧对象（errcode!=0）→ 转成带 errcode/errmsg 的可读 Error", async () => {
	const sendMessage = mock(async () => {
		throw {
			headers: { req_id: "r" },
			errcode: 45009,
			errmsg: "api freq out of limit",
		};
	});
	const adapter = new WecomAdapter(channel);
	(adapter as any).client = { sendMessage };
	await expect(adapter.pushMessage("user_1", "你好")).rejects.toThrow(
		/45009.*api freq out of limit/,
	);
	expect(sendMessage).toHaveBeenCalledWith(
		"user_1",
		expect.objectContaining({ msgtype: "markdown" }),
	);
});

test("pushMessage：SDK reject 普通 Error → 原样透传", async () => {
	const sendMessage = mock(async () => {
		throw new Error("connection closed");
	});
	const adapter = new WecomAdapter(channel);
	(adapter as any).client = { sendMessage };
	await expect(adapter.pushMessage("user_1", "hi")).rejects.toThrow(
		"connection closed",
	);
});
