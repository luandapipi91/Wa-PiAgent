import { create } from "zustand";
import { api } from "../api-client";
import type { ContactEntity } from "@wa-pi/shared";

interface ContactsState {
	contacts: ContactEntity[];
	loadContacts: () => Promise<void>;
	renameContact: (id: string, remark: string) => Promise<void>;
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
}));

/** 按 channelId + kind + id 查备注名（供 ImConversationList 回显） */
export function remarkOf(
	contacts: ContactEntity[],
	channelId: string,
	kind: "person" | "group",
	key: string,
): string | undefined {
	return contacts.find(
		(c) =>
			c.channelId === channelId &&
			c.kind === kind &&
			(kind === "group" ? c.chatId === key : c.userId === key),
	)?.remark;
}
