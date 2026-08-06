import { expect, test } from "bun:test";
import { normalizeInbound } from "../src/channels/wecom-adapter";

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

test("图片消息：image 字段携带 url+aeskey", () => {
	const msg = normalizeInbound({
		headers: { req_id: "r3" },
		body: {
			msgid: "m3",
			chattype: "single",
			from: { userid: "u1" },
			msgtype: "image",
			image: { url: "https://x", aeskey: "k" },
		},
	});
	expect(msg!.image).toEqual({ url: "https://x", aeskey: "k", name: "m3.png" });
});

test("voice/file 等 → unsupported；空文本 → null", () => {
	const voice = normalizeInbound({
		headers: { req_id: "r4" },
		body: { msgid: "m4", chattype: "single", from: { userid: "u1" }, msgtype: "voice" },
	});
	expect(voice!.unsupported).toBe("voice");
	const empty = normalizeInbound({
		headers: { req_id: "r5" },
		body: { msgid: "m5", chattype: "single", from: { userid: "u1" }, msgtype: "text", text: { content: "  " } },
	});
	expect(empty).toBeNull();
});
