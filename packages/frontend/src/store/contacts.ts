import { create } from "zustand";
import { api } from "../api-client";
import type { ContactEntity } from "@wa-pi/shared";

interface ContactsState {
	contacts: ContactEntity[];
	loadContacts: () => Promise<void>;
	renameContact: (id: string, remark: string) => Promise<void>;
	ensureContact: (input: ContactEnsureInput) => Promise<ContactEntity | undefined>;
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
		set({ contacts: res?.contacts ?? [] });
	},
	renameContact: async (id, remark) => {
		const res = (await api.put(`/api/contacts/${id}`, { remark })) as any;
		set({ contacts: res?.contacts ?? [] });
	},
	ensureContact: async (input) => {
		const res = (await api.post("/api/contacts/ensure", input)) as any;
		return res?.contact as ContactEntity | undefined;
	},
}));

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
