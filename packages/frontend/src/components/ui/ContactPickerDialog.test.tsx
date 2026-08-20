// ContactPickerDialog 组件测试：标题通讯录数量 / 按名字搜索 / 多选确认 / 取消 / 空态
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";

const baseContacts = () => [
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
	{
		id: "ct_3",
		channelId: "ch_2",
		kind: "person",
		userId: "LiSi",
		remark: "李四",
		firstChatAt: 0,
		lastChatAt: 0,
	},
];

const contactState = {
	contacts: baseContacts() as any[],
	loadContacts: mock(async () => {}),
	syncWecomContacts: mock(async () => ({ added: 0, updated: 0 })),
};
const useContactsStore = (selector: (s: typeof contactState) => unknown) =>
	selector(contactState);
(useContactsStore as any).getState = () => contactState;
mock.module("../../store/contacts", () => ({
	useContactsStore,
	contactLabel: (c: any) =>
		c.remark || (c.kind === "group" ? c.chatId?.slice(0, 8) : c.userId) || c.id,
}));

// channels store：可配置 wecom 渠道列表（有 wecom = 有同步权限）
const channelsState = {
	bots: [] as any[],
};
const useChannelsStore = (selector: (s: typeof channelsState) => unknown) =>
	selector(channelsState);
(useChannelsStore as any).getState = () => channelsState;
mock.module("../../store/channels", () => ({
	useChannelsStore,
}));

const { ContactPickerDialog } = await import("./ContactPickerDialog");

beforeEach(() => {
	contactState.contacts = baseContacts() as any[];
	contactState.loadContacts.mockReset();
	contactState.syncWecomContacts.mockReset();
	channelsState.bots = [];
});
afterEach(() => cleanup());

test("标题显示「我的通讯录（x）」，x 为联系人总数", () => {
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	expect(screen.getByText("我的通讯录（3）")).toBeTruthy();
});

test("按名字搜索过滤联系人：输入不过滤，点搜索后才过滤", () => {
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const input = screen.getByTestId("contact-picker-search");
	// 输入「李」：尚未点搜索，列表不过滤（张三仍在）
	fireEvent.change(input, { target: { value: "李" } });
	expect(screen.getByText("张三")).toBeTruthy();
	// 点搜索：按关键词过滤，只显示李四
	fireEvent.click(screen.getByTestId("contact-picker-search-btn"));
	expect(screen.getByText("李四")).toBeTruthy();
	expect(screen.queryByText("张三")).toBeNull();
});

test("搜索无结果 → 显示无匹配文案（点搜索后）", () => {
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	fireEvent.change(screen.getByTestId("contact-picker-search"), {
		target: { value: "zzz" },
	});
	fireEvent.click(screen.getByTestId("contact-picker-search-btn"));
	expect(screen.getByTestId("contact-picker-empty").textContent).toContain(
		"无匹配",
	);
});

test("未选中时确认按钮禁用；多选后确认回调返回全部目标（按通讯录顺序）", async () => {
	const picks: any[] = [];
	render(
		<ContactPickerDialog
			onPick={(ts) => picks.push(...ts)}
			onCancel={() => {}}
		/>,
	);
	const ok = screen.getByTestId("contact-picker-ok") as HTMLButtonElement;
	expect(ok.disabled).toBe(true);
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_1"));
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_3"));
	await act(async () => {});
	expect(ok.disabled).toBe(false);
	fireEvent.click(ok);
	expect(picks).toEqual([
		{ channelId: "ch_1", contactId: "ct_1", label: "张三", kind: "person" },
		{ channelId: "ch_2", contactId: "ct_3", label: "李四", kind: "person" },
	]);
});

test("再次点击已选项取消选中", () => {
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const ok = screen.getByTestId("contact-picker-ok") as HTMLButtonElement;
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_1"));
	expect(ok.disabled).toBe(false);
	fireEvent.click(screen.getByTestId("contact-picker-item-ct_1"));
	expect(ok.disabled).toBe(true);
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

test("联系人名字过长时截断，不溢出弹窗", () => {
	contactState.contacts = [
		{
			id: "ct_long",
			channelId: "ch_1",
			kind: "person",
			userId: "wmQzBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
			firstChatAt: 0,
			lastChatAt: 0,
		},
	];
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const name = screen.getByText(/wmQzB/);
	expect(name.className).toContain("truncate");
	expect(name.className).toContain("min-w-0");
});

// ===== 企微搜索好友同步（有权限同步，无权限仅本地过滤）=====

test("有 wecom 渠道：按钮显示「搜索好友」，点击后同步企微成员并刷新本地", async () => {
	channelsState.bots = [
		{ id: "ch_wecom", type: "wecom", name: "企微机器人" },
		{ id: "ch_other", type: "mock", name: "其它" },
	];
	contactState.syncWecomContacts.mockResolvedValue({ added: 3, updated: 0 });
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const input = screen.getByTestId("contact-picker-search");
	const searchBtn = screen.getByTestId("contact-picker-search-btn");
	expect(screen.getByText("搜索好友")).toBeTruthy();
	fireEvent.change(input, { target: { value: "张" } });
	fireEvent.click(searchBtn);
	await act(async () => {});
	// 仅同步 wecom 渠道，跳过非 wecom
	expect(contactState.syncWecomContacts).toHaveBeenCalledTimes(1);
	expect(contactState.syncWecomContacts).toHaveBeenCalledWith("ch_wecom", [
		"张",
	]);
	expect(contactState.loadContacts).toHaveBeenCalled();
});

test("无 wecom 渠道（无权限）→ 按钮仍显示「搜索好友」，点击仅本地过滤不触发同步", async () => {
	channelsState.bots = [{ id: "ch_other", type: "mock", name: "其它" }];
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const searchBtn = screen.getByTestId("contact-picker-search-btn");
	expect(screen.getByText("搜索好友")).toBeTruthy();
	const input = screen.getByTestId("contact-picker-search");
	fireEvent.change(input, { target: { value: "李" } });
	fireEvent.click(searchBtn);
	await act(async () => {});
	// 不触发同步
	expect(contactState.syncWecomContacts).not.toHaveBeenCalled();
	// 本地过滤仍生效
	expect(screen.getByText("李四")).toBeTruthy();
	expect(screen.queryByText("张三")).toBeNull();
});

test("搜索词为空 → 点搜索好友不触发同步", async () => {
	channelsState.bots = [{ id: "ch_wecom", type: "wecom", name: "企微机器人" }];
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const searchBtn = screen.getByTestId("contact-picker-search-btn");
	fireEvent.change(screen.getByTestId("contact-picker-search"), {
		target: { value: "  " },
	});
	fireEvent.click(searchBtn);
	await act(async () => {});
	expect(contactState.syncWecomContacts).not.toHaveBeenCalled();
});

test("清空输入框后点「搜索好友」→ 重置过滤恢复全量", async () => {
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	const searchBtn = screen.getByTestId("contact-picker-search-btn");
	const input = screen.getByTestId("contact-picker-search");
	// 先搜索「李」：只剩李四
	fireEvent.change(input, { target: { value: "李" } });
	fireEvent.click(searchBtn);
	expect(screen.queryByText("张三")).toBeNull();
	// 清空输入框再点搜索：恢复全量
	fireEvent.change(input, { target: { value: "" } });
	fireEvent.click(searchBtn);
	expect(screen.getByText("张三")).toBeTruthy();
	expect(screen.getByText("李四")).toBeTruthy();
});

test("同步失败（如已过期）→ 静默忽略，不 toast 不阻塞本地搜索", async () => {
	channelsState.bots = [{ id: "ch_wecom", type: "wecom", name: "企微机器人" }];
	contactState.syncWecomContacts.mockRejectedValue(new Error("token 过期"));
	render(<ContactPickerDialog onPick={() => {}} onCancel={() => {}} />);
	fireEvent.change(screen.getByTestId("contact-picker-search"), {
		target: { value: "张" },
	});
	fireEvent.click(screen.getByTestId("contact-picker-search-btn"));
	// 同步失败不应让本地过滤出错
	await act(async () => {});
	expect(screen.getByText("张三")).toBeTruthy();
});
