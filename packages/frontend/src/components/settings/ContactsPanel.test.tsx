import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";

// mock store：返回固定 contacts + renameContact（组件里用了 useContactsStore((s)=>s.contacts)
// 和 useContactsStore.getState()，所以 mock 需同时支持 selector 调用与 getState()）
const renameContact = mock(async () => {});
const loadContacts = mock(async () => {});
const toastAdd = mock(() => {});

const baseContacts = (): any[] => [
	{
		id: "ct_1",
		channelId: "ch_a",
		kind: "person",
		userId: "u1",
		firstChatAt: 1,
		lastChatAt: 2,
	},
	{
		id: "ct_2",
		channelId: "ch_a",
		kind: "group",
		chatId: "g1",
		firstChatAt: 1,
		lastChatAt: 2,
	},
];

const state = {
	contacts: baseContacts(),
	renameContact,
	loadContacts,
};

const useContactsStore = (selector: (s: typeof state) => unknown) =>
	selector(state);
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

test("侧滑为覆盖式定位：absolute 贴右缘 + 不透明背景，不占布局流", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	const panel = screen.getByTestId("contacts-panel");
	// 覆盖式：脱离文档流，贴容器右缘，高于内容但低于 Modal(z-50)
	expect(panel.className).toContain("absolute");
	expect(panel.className).toContain("right-0");
	expect(panel.className).toContain("z-40");
	// 覆盖后须有不透明背景，防透出底层表单
	expect(panel.style.background).toBe("var(--surface)");
});

test("渲染人/群两类列表", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	expect(screen.getByText(/人/)).toBeTruthy();
	expect(screen.getByText(/群/)).toBeTruthy();
	expect(screen.getByText("u1")).toBeTruthy();
});

test("联系人名字过长时截断（truncate + min-w-0），不溢出面板", () => {
	state.contacts = [
		{
			id: "ct_long",
			channelId: "ch_a",
			kind: "person",
			userId: "wmQzBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	const name = screen.getByText(/wmQzB/);
	expect(name.className).toContain("truncate");
	expect(name.className).toContain("min-w-0");
});

test("点击行展开输入框，保存调用 renameContact", async () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("u1"));
	const input = screen.getByRole("textbox");
	fireEvent.change(input, { target: { value: "张三" } });
	fireEvent.click(screen.getByText("保存"));
	expect(renameContact).toHaveBeenCalledWith("ct_1", "张三");
	// 等待 save 异步完成（setEditingId(null) 收起输入框），消除异步状态更新的 act 警告
	await act(async () => {});
});

test("点人名展开编辑：输入框回填当前显示名（无 remark 时回填 userId），名字不丢", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("u1"));
	// remark 为空 → 应回填行上显示的名字，而不是空输入框
	expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("u1");
});

test("编辑态为行内替换：名字行消失只留输入框，取消后名字行恢复", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("u1"));
	// 进入编辑：名字行消失（u1 文本不在 DOM，input 的 value 不算 text 节点）
	expect(screen.queryByText("u1")).toBeNull();
	expect(screen.getByRole("textbox")).toBeTruthy();
	// 取消：输入框消失，名字行恢复
	fireEvent.click(screen.getByText("取消"));
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.getByText("u1")).toBeTruthy();
});

test("点群名展开编辑：输入框回填 chatId 前 8 位显示名", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("g1"));
	expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("g1");
});

test("编辑态 input 长名显示省略号（text-ellipsis），不横向撑开", () => {
	state.contacts = [
		{
			id: "ct_long",
			channelId: "ch_a",
			kind: "person",
			userId: "wmQzBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText(/wmQzB/));
	const input = screen.getByRole("textbox") as HTMLInputElement;
	expect(input.className).toContain("text-ellipsis");
});

test("行内编辑 input 可收缩（min-w-0）：窄面板内保存/取消按钮不被挤出去", () => {
	render(<ContactsPanel channelId="ch_a" onClose={() => {}} />);
	fireEvent.click(screen.getByText("u1"));
	// flex item 默认 min-width:auto，input 固有宽度不可收缩会把按钮溢出裁剪区外
	expect(screen.getByRole("textbox").className).toContain("min-w-0");
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

// ===== 企微通讯录搜索同步 =====

test("wecom 渠道显示常驻搜索框 + 「搜索好友」按钮，非 wecom 不显示", () => {
	const { rerender } = render(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="wecom" />,
	);
	// 搜索框常驻（不需要点按钮展开）
	expect(screen.getByTestId("contacts-sync-wecom-input")).toBeTruthy();
	expect(screen.getByText("搜索好友")).toBeTruthy();
	expect(screen.queryByText("同步企微通讯录好友")).toBeNull();
	rerender(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="mock" />,
	);
	expect(screen.queryByTestId("contacts-sync-wecom-input")).toBeNull();
});

test("输入关键词点「搜索好友」→ 仅本地过滤，不调同步接口", async () => {
	render(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="wecom" />,
	);
	const input = screen.getByTestId("contacts-sync-wecom-input");
	fireEvent.change(input, { target: { value: "张" } });
	fireEvent.click(screen.getByText("搜索好友"));
	await act(async () => {});
	// 纯本地过滤：不弹 toast（无同步结果）
	expect(toastAdd).not.toHaveBeenCalled();
});

test("搜索框输入关键词不过滤，点「搜索好友」后才按显示名过滤", () => {
	state.contacts = [
		{
			id: "ct_1",
			channelId: "ch_a",
			kind: "person",
			userId: "u1",
			remark: "张文明",
			firstChatAt: 1,
			lastChatAt: 2,
		},
		{
			id: "ct_2",
			channelId: "ch_a",
			kind: "person",
			userId: "u2",
			remark: "李四",
			firstChatAt: 1,
			lastChatAt: 2,
		},
		{
			id: "ct_3",
			channelId: "ch_a",
			kind: "group",
			chatId: "g1",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	// 无 wecom 渠道也应有搜索框（本地过滤）——这里给 wecom 场景：点搜索后过滤
	render(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="wecom" />,
	);
	const input = screen.getByTestId("contacts-sync-wecom-input");
	// 输入「张」：未点搜索，不过滤（三人都在）
	fireEvent.change(input, { target: { value: "张" } });
	expect(screen.getByText("张文明")).toBeTruthy();
	expect(screen.getByText("李四")).toBeTruthy();
	expect(screen.getByText("g1")).toBeTruthy();
	// 点「搜索好友」：只显示张文明（按显示名过滤，人/群统一过滤）
	fireEvent.click(screen.getByText("搜索好友"));
	expect(screen.getByText("张文明")).toBeTruthy();
	expect(screen.queryByText("李四")).toBeNull();
	expect(screen.queryByText("g1")).toBeNull();
});

test("搜索无匹配 → 列表区显示暂无，不报错（点搜索后）", async () => {
	render(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="wecom" />,
	);
	fireEvent.change(screen.getByTestId("contacts-sync-wecom-input"), {
		target: { value: "不存在的关键词" },
	});
	fireEvent.click(screen.getByText("搜索好友"));
	await act(async () => {});
	// 无匹配时显示「暂无对话过的人/群」空态
	expect(screen.getByText("暂无对话过的人/群")).toBeTruthy();
});

test("搜索后输入框保留关键词，过滤继续生效", () => {
	state.contacts = [
		{
			id: "ct_1",
			channelId: "ch_a",
			kind: "person",
			userId: "u1",
			remark: "张文明",
			firstChatAt: 1,
			lastChatAt: 2,
		},
		{
			id: "ct_2",
			channelId: "ch_a",
			kind: "person",
			userId: "u2",
			remark: "李四",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	render(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="wecom" />,
	);
	const input = screen.getByTestId("contacts-sync-wecom-input");
	fireEvent.change(input, { target: { value: "张" } });
	fireEvent.click(screen.getByText("搜索好友"));
	// 输入框仍保留关键词
	expect((input as HTMLInputElement).value).toBe("张");
	// 本地过滤继续生效：只显示张文明
	expect(screen.getByText("张文明")).toBeTruthy();
	expect(screen.queryByText("李四")).toBeNull();
});

test("清空输入框后点「搜索好友」→ 重置过滤恢复全量", async () => {
	state.contacts = [
		{
			id: "ct_1",
			channelId: "ch_a",
			kind: "person",
			userId: "u1",
			remark: "张文明",
			firstChatAt: 1,
			lastChatAt: 2,
		},
		{
			id: "ct_2",
			channelId: "ch_a",
			kind: "person",
			userId: "u2",
			remark: "李四",
			firstChatAt: 1,
			lastChatAt: 2,
		},
	];
	render(
		<ContactsPanel channelId="ch_a" onClose={() => {}} channelType="wecom" />,
	);
	const input = screen.getByTestId("contacts-sync-wecom-input");
	// 先搜索「张」：只剩张文明
	fireEvent.change(input, { target: { value: "张" } });
	fireEvent.click(screen.getByText("搜索好友"));
	expect(screen.queryByText("李四")).toBeNull();
	// 清空输入框再点搜索：恢复全量
	fireEvent.change(input, { target: { value: "" } });
	fireEvent.click(screen.getByText("搜索好友"));
	expect(screen.getByText("张文明")).toBeTruthy();
	expect(screen.getByText("李四")).toBeTruthy();
});
