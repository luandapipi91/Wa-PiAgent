import { create } from "zustand";
import { api } from "../api-client";
import { registerContactMeta } from "../quick-invoke/tokens";
import type { ContactEntity } from "@wa-pi/shared";

interface ContactsState {
	contacts: ContactEntity[];
	loadContacts: () => Promise<void>;
	renameContact: (id: string, remark: string) => Promise<void>;
	ensureContact: (input: ContactEnsureInput) => Promise<ContactEntity | undefined>;
	syncWecomContacts: (
		channelId: string,
		keywords: string[],
	) => Promise<{ added: number; updated: number }>;
}

/** ensureContact 入参：按 channelId + kind + 匹配键确保联系人存在 */
export interface ContactEnsureInput {
	channelId: string;
	kind: "person" | "group";
	userId?: string;
	chatId?: string;
}

export const useContactsStore = create<ContactsState>((set) => ({
	contacts: [],
	loadContacts: async () => {
		const res = (await api.get("/api/contacts")) as any;
		const contacts = (res?.contacts ?? []) as ContactEntity[];
		set({ contacts });
		registerAllContactMeta(contacts);
	},
	renameContact: async (id, remark) => {
		const res = (await api.put(`/api/contacts/${id}`, { remark })) as any;
		const contacts = (res?.contacts ?? []) as ContactEntity[];
		set({ contacts });
		registerAllContactMeta(contacts);
	},
	ensureContact: async (input) => {
		const res = (await api.post("/api/contacts/ensure", input)) as any;
		return res?.contact as ContactEntity | undefined;
	},
	syncWecomContacts: async (channelId, keywords) => {
		const res = (await api.post("/api/contacts/sync-wecom", {
			channelId,
			keywords,
		})) as any;
		return { added: res?.added ?? 0, updated: res?.updated ?? 0 };
	},
}));

/** 联系人显示名：remark 优先；group 退 chatId 前 8 位、person 退 userId；兜底 id */
export function contactLabel(c: ContactEntity): string {
	return (
		c.remark ||
		(c.kind === "group" ? c.chatId?.slice(0, 8) : c.userId) ||
		c.id
	);
}

/** 把联系人列表批量注册进 chip 渲染表（主聊天输入框/历史消息的 chip-im 依赖它） */
function registerAllContactMeta(contacts: ContactEntity[]) {
	for (const c of contacts) {
		registerContactMeta(c.id, { label: contactLabel(c), kind: c.kind });
	}
}

/** 按 channelId + kind + key 查完整联系人对象（供顶部铅笔定位联系人 id） */
export function contactOf(
	contacts: ContactEntity[],
	channelId: string,
	kind: "person" | "group",
	key: string,
): ContactEntity | undefined {
	return contacts.find(
		(c) =>
			c.channelId === channelId &&
			c.kind === kind &&
			(kind === "group" ? c.chatId === key : c.userId === key),
	);
}

/** 按 channelId + kind + id 查备注名（供 ImConversationList 回显） */
export function remarkOf(
	contacts: ContactEntity[],
	channelId: string,
	kind: "person" | "group",
	key: string,
): string | undefined {
	return contactOf(contacts, channelId, kind, key)?.remark;
}
