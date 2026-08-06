import { create } from "zustand";
import { api } from "../api-client";
import type {
	ChannelConfig,
	ChannelConversationInfo,
	ChannelStatusInfo,
} from "@wa-pi/shared";

/** 新建/更新渠道的入参（id/createdAt 由 kernel 生成） */
export type ChannelInput = Omit<ChannelConfig, "id" | "createdAt">;

interface ChannelsState {
	bots: ChannelStatusInfo[];
	conversations: ChannelConversationInfo[];
	loadBots: () => Promise<void>;
	loadConversations: () => Promise<void>;
	createBot: (channel: ChannelInput) => Promise<void>;
	updateBot: (id: string, patch: Partial<ChannelInput>) => Promise<void>;
	deleteBot: (id: string) => Promise<void>;
}

export const useChannelsStore = create<ChannelsState>((set) => ({
	bots: [],
	conversations: [],
	loadBots: async () => {
		const res = (await api.get("/api/channels")) as any;
		set({ bots: res?.channels ?? [] });
	},
	loadConversations: async () => {
		const res = (await api.get("/api/channel-conversations")) as any;
		set({ conversations: res?.conversations ?? [] });
	},
	createBot: async (channel) => {
		const res = (await api.post("/api/channels", { channel })) as any;
		set({ bots: res?.channels ?? [] });
	},
	updateBot: async (id, patch) => {
		const res = (await api.put(`/api/channels/${id}`, { channel: patch })) as any;
		set({ bots: res?.channels ?? [] });
	},
	deleteBot: async (id) => {
		const res = (await api.del(`/api/channels/${id}`)) as any;
		set({ bots: res?.channels ?? [] });
	},
}));
