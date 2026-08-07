import { expect, test } from "bun:test";
import { MockAdapter } from "../src/channels/mock-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

const channel: ChannelConfig = {
	id: "ch_mock",
	type: "mock",
	name: "测试机器人",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "前端开发者",
	model: null,
	extraSystemPrompt: "",
	replyGranularity: "standard",
	defaultProjectId: "__system__",
	allowProjectSwitch: false,
	createdAt: 1,
};

test("MockAdapter：inject 触发 onMessage，sendText 记录 outbox", async () => {
	const a = new MockAdapter(channel);
	const received: any[] = [];
	a.onMessage((m) => received.push(m));
	const statuses: string[] = [];
	a.onStatus((s) => statuses.push(s));
	await a.connect();
	expect(statuses).toContain("connected");

	a.inject({ chatId: "u1", text: "你好" });
	expect(received).toHaveLength(1);
	expect(received[0].chatType).toBe("single"); // 缺省 single
	expect(received[0].msgId).toBeTruthy(); // 自动补 msgId
	expect(received[0].replyFrame).toBeTruthy();

	await a.sendText(received[0].replyFrame, "**回复**");
	expect(a.outbox).toHaveLength(1);
	expect(a.outbox[0].text).toBe("**回复**");

	await a.disconnect();
	expect(a.status).toBe("disconnected");
});
