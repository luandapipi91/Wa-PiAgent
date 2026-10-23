// contacts store → chip 渲染注册表：loadContacts 后 textToHtml 能渲染联系人 chip
import { expect, mock, test } from "bun:test";

const contacts = [
	{
		id: "ct_1",
		channelId: "ch_1",
		kind: "person",
		userId: "ZhangSan",
		remark: "张三",
		firstChatAt: 0,
		lastChatAt: 0,
	},
	{
		id: "ct_2",
		channelId: "ch_1",
		kind: "group",
		chatId: "wrabcde123456789",
		firstChatAt: 0,
		lastChatAt: 0,
	},
];

mock.module("../api-client", () => ({
	api: {
		get: async (path: string) =>
			path === "/api/contacts" ? { contacts } : {},
		post: async () => ({}),
		put: async () => ({ contacts }),
		del: async () => ({}),
	},
}));

const { useContactsStore, contactLabel } = await import("./contacts");
const { textToHtml, clearContactMeta } = await import("../quick-invoke/tokens");

test("loadContacts 后所有联系人注册进 chip 渲染表", async () => {
	clearContactMeta();
	await useContactsStore.getState().loadContacts();
	const html = textToHtml("@im-push-to(ch_1,ct_1)");
	expect(html).toContain("张三");
	expect(html).not.toContain("chip-im-invalid");
});

test("contactLabel：remark 优先；group 无 remark 用 chatId 前 8 位", () => {
	expect(contactLabel(contacts[0] as any)).toBe("张三");
	expect(contactLabel(contacts[1] as any)).toBe("wrabcde1");
});
