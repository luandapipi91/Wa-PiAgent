// ContactPickerDialog 组件测试：渠道分组渲染 / 单选 / 确认回调 / 取消 / 空态
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const baseContacts = () => [
	{ id: "ct_1", channelId: "ch_1", kind: "person", userId: "ZhangSan", remark: "张三", firstChatAt: 0, lastChatAt: 0 },
	{ id: "ct_2", channelId: "ch_1", kind: "group", chatId: "wrabcde123456789", firstChatAt: 0, lastChatAt: 0 },
	{ id: "ct_3", channelId: "ch_2", kind: "person", userId: "LiSi", remark: "李四", firstChatAt: 0, lastChatAt: 0 },
];
const baseBots = () => [
	{ id: "ch_1", name: "企微机器人A" },
	{ id: "ch_2", name: "企微机器人B" },
];

const contactState = {
	contacts: baseContacts() as any[],
	loadContacts: mock(async () => {}),
};
const channelState = {
	bots: baseBots() as any[],
	loadBots: mock(async () => {}),
};
const useContactsStore = (selector: (s: typeof contactState) => unknown) => selector(contactState);
(useContactsStore as any).getState = () => contactState;
const useChannelsStore = (selector: (s: typeof channelState) => unknown) => selector(channelState);
(useChannelsStore as any).getState = () => channelState;
mock.module("../../store/contacts", () => ({
	useContactsStore,
	contactLabel: (c: any) => c.remark || (c.kind === "group" ? c.chatId?.slice(0, 8) : c.userId) || c.id,
}));
mock.module("../../store/channels", () => ({ useChannelsStore }));

const { ContactPickerDialog } = await import("./ContactPickerDialog");

beforeEach(() => {
	contactState.contacts = baseContacts() as any[];
	channelState.bots = baseBots() as any[];
});
afterEach(() => cleanup());

test("按渠道分组渲染联系人（渠道名 + 联系人显示名）", () => {
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	expect(screen.getByText("企微机器人A")).toBeTruthy();
	expect(screen.getByText("企微机器人B")).toBeTruthy();
	expect(screen.getByText("张三")).toBeTruthy();
	expect(screen.getByText("李四")).toBeTruthy();
	expect(screen.getByText("wrabcde1")).toBeTruthy(); // group 无 remark → chatId 前 8 位
});

test("未选中时确认按钮禁用；单选后确认回调返回目标", async () => {
	const picks: any[] = [];
	render(<ContactPickerDialog onPick={(t) => picks.push(t)} onCancel={() => {}} />);
	const ok = screen.getByTestId("contact-picker-ok") as HTMLButtonElement;
	expect(ok.disabled).toBe(true);
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_1"));
	await act(async () => {});
	expect(ok.disabled).toBe(false);
	fireEvent.click(ok);
	expect(picks).toEqual([
		{ channelId: "ch_1", contactId: "ct_1", label: "张三", kind: "person" },
	]);
});

test("取消按钮与关闭按钮触发 onCancel", () => {
	let cancelled = 0;
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => cancelled++} />);
	fireEvent.click(screen.getByTestId("contact-picker-cancel"));
	fireEvent.click(screen.getByTestId("contact-picker-close"));
	expect(cancelled).toBe(2);
});

test("无联系人时显示空态引导", () => {
	contactState.contacts = [];
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	expect(screen.getByTestId("contact-picker-empty").textContent).toContain("IM");
});
