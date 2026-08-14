import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// mock store：返回固定 contacts + renameContact（组件里用了 useContactsStore((s)=>s.contacts)
// 和 useContactsStore.getState()，所以 mock 需同时支持 selector 调用与 getState()）
const renameContact = mock(async () => {});
const loadContacts = mock(async () => {});

const state = {
	contacts: [
		{ id: "ct_1", channelId: "ch_a", kind: "person", userId: "u1", firstChatAt: 1, lastChatAt: 2 },
		{ id: "ct_2", channelId: "ch_a", kind: "group", chatId: "g1", firstChatAt: 1, lastChatAt: 2 },
	],
	renameContact,
	loadContacts,
};

const useContactsStore = (selector: (s: typeof state) => unknown) => selector(state);
(useContactsStore as any).getState = () => state;

mock.module("../../store/contacts", () => ({
	useContactsStore,
}));

const { default: ContactsPanel } = await import("./ContactsPanel");

beforeEach(() => renameContact.mockReset());
afterEach(() => cleanup());

test("渲染人/群两类列表", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	expect(screen.getByText(/人/)).toBeTruthy();
	expect(screen.getByText(/群/)).toBeTruthy();
	expect(screen.getByText("u1")).toBeTruthy();
});

test("点行展开输入框，保存调用 renameContact", async () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("u1"));
	const input = screen.getByRole("textbox");
	fireEvent.change(input, { target: { value: "张三" } });
	fireEvent.click(screen.getByText("保存"));
	expect(renameContact).toHaveBeenCalledWith("ct_1", "张三");
	// 等待 save 异步完成（setEditingId(null) 收起输入框），消除异步状态更新的 act 警告
	await act(async () => {});
});
