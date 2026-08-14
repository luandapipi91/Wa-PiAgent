import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// mock store：返回固定 contacts + renameContact（组件里用了 useContactsStore((s)=>s.contacts)
// 和 useContactsStore.getState()，所以 mock 需同时支持 selector 调用与 getState()）
const renameContact = mock(async () => {});
const loadContacts = mock(async () => {});
const toastAdd = mock(() => {});

const baseContacts = (): any[] => [
	{ id: "ct_1", channelId: "ch_a", kind: "person", userId: "u1", firstChatAt: 1, lastChatAt: 2 },
	{ id: "ct_2", channelId: "ch_a", kind: "group", chatId: "g1", firstChatAt: 1, lastChatAt: 2 },
];

const state = {
	contacts: baseContacts(),
	renameContact,
	loadContacts,
};

const useContactsStore = (selector: (s: typeof state) => unknown) => selector(state);
(useContactsStore as any).getState = () => state;

mock.module("../../store/contacts", () => ({
	useContactsStore,
}));
// 组件通过 useToastStore.getState().add 弹失败 toast，这里 mock 掉以断言错误消息
mock.module("../../store/toast", () => ({
	useToastStore: { getState: () => ({ add: toastAdd, toasts: [] }) },
}));

const { default: ContactsPanel } = await import("./ContactsPanel");

beforeEach(() => {
	renameContact.mockReset();
	loadContacts.mockReset();
	toastAdd.mockReset();
	state.contacts = baseContacts();
});
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

test("备注名优先显示，而非原始 userId", () => {
	state.contacts[0] = { ...state.contacts[0], remark: "张总" };
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	expect(screen.getByText("张总")).toBeTruthy();
	expect(screen.queryByText("u1")).toBeNull();
});

test("重命名失败时 toast 收到 error 消息", async () => {
	renameContact.mockImplementation(() => Promise.reject(new Error("boom")));
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("u1"));
	const input = screen.getByRole("textbox");
	fireEvent.change(input, { target: { value: "张三" } });
	fireEvent.click(screen.getByText("保存"));
	await act(async () => {});
	expect(toastAdd).toHaveBeenCalledWith("boom", "error");
});
