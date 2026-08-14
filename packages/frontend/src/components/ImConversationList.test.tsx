import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// 复用真实 remarkOf（纯函数，被 titleOf 调用）；仅 mock 各 store 的 hook/getState。
import { remarkOf } from "../store/contacts";

const loadConversations = mock(async () => {});
const loadContacts = mock(async () => {});
const renameContact = mock(async () => {});

// channels store：组件用 useChannelsStore((s)=>s.conversations) 与 getState().loadConversations()
const channelsState = {
	conversations: [] as any[],
	loadConversations,
};
const useChannelsStore = (selector: (s: typeof channelsState) => unknown) =>
	selector(channelsState);
(useChannelsStore as any).getState = () => channelsState;

// contacts store：组件用 useContactsStore((s)=>s.contacts)
const contactsState = {
	contacts: [] as any[],
	loadContacts,
	renameContact,
};
const useContactsStore = (selector: (s: typeof contactsState) => unknown) =>
	selector(contactsState);
(useContactsStore as any).getState = () => contactsState;

mock.module("../store/channels", () => ({ useChannelsStore }));
mock.module("../store/contacts", () => ({ useContactsStore, remarkOf }));

const { ImConversationList } = await import("./ImConversationList");

/** 构造一个会话项，字段可覆盖 */
function conv(over: Record<string, unknown>): any {
	return {
		channelId: "ch_a",
		channelName: "企微",
		channelType: "wecom",
		chatId: "u1",
		chatType: "single",
		fromUserId: "u1",
		sessionId: "s1",
		projectId: "p1",
		projectName: "proj",
		lastMessagePreview: "hi",
		updatedAt: 1000,
		...over,
	};
}

beforeEach(() => {
	loadConversations.mockReset();
	loadContacts.mockReset();
	renameContact.mockReset();
	contactsState.contacts = [];
	channelsState.conversations = [];
});
afterEach(() => cleanup());

test("单聊命中备注：显示 remark 而非 userid", () => {
	contactsState.contacts = [
		{
			id: "ct_1",
			channelId: "ch_a",
			kind: "person",
			userId: "user_alice",
			remark: "张总",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	channelsState.conversations = [
		conv({ chatId: "user_alice", fromUserId: "user_alice", sessionId: "s1" }),
	];
	render(<ImConversationList onSelectSession={() => {}} />);
	expect(screen.getByText("张总")).toBeTruthy();
	expect(screen.queryByText("user_alice")).toBeNull();
});

test("群聊命中备注：显示 remark 而非群聊标题", () => {
	contactsState.contacts = [
		{
			id: "ct_2",
			channelId: "ch_a",
			kind: "group",
			chatId: "g12345678",
			remark: "项目群",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	channelsState.conversations = [
		conv({
			chatId: "g12345678",
			chatType: "group",
			fromUserId: "user_bob",
			sessionId: "s2",
		}),
	];
	render(<ImConversationList onSelectSession={() => {}} />);
	expect(screen.getByText("项目群")).toBeTruthy();
	expect(screen.queryByText(/群聊/)).toBeNull();
});

test("未命中备注：回退原逻辑（单聊 chatId / 群聊标题）", () => {
	channelsState.conversations = [
		conv({ chatId: "user_alice", fromUserId: "user_alice", sessionId: "s1" }),
		conv({
			chatId: "g12345678",
			chatType: "group",
			fromUserId: "user_bob",
			sessionId: "s2",
		}),
	];
	render(<ImConversationList onSelectSession={() => {}} />);
	expect(screen.getByText("user_alice")).toBeTruthy();
	expect(screen.getByText(/群聊\(g1234567\)/)).toBeTruthy();
});
