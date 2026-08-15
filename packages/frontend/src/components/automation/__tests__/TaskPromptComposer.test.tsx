// TaskPromptComposer 组件测试（bun:test，匹配本项目既有组件测试约定）。
// 输入框本体与 $ 技能弹窗由公共组件 SkillSuggestTextarea 提供（其行为由
// tests/SkillSuggestTextarea.test.tsx 覆盖），本文件只测 TaskPromptComposer
// 自己的职责：@ 联系人选择器触发/替换/关闭，以及提示行渲染。
//
// @ 语义：选择 IM 渠道通讯录里的「某个人」（kind=person），插入 @ct_xxx
// （联系人 id），任务执行时经 kernel 主动推送到该联系人——而不是渠道本身。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TaskPromptComposer } from "../TaskPromptComposer";

// channels store：提供渠道名（供 @ 弹窗按渠道分组展示），不再作为弹窗数据源
mock.module("../../../store/channels", () => ({
	useChannelsStore: () => ({
		bots: [
			{ id: "bot_aaa", name: "企微", status: "connected" },
			{ id: "bot_bbb", name: "飞书", status: "connected" },
		],
	}),
}));

// contacts store：提供 person 联系人（通讯录），供 @ 弹窗选择。
// 组件无参调用 useContactsStore() 取整个 state，也按 zustand selector 取子集，mock 需两者都支持。
mock.module("../../../store/contacts", () => {
	const contacts = [
		{
			id: "ct_p01",
			channelId: "bot_aaa",
			kind: "person",
			userId: "zhangsan",
			remark: "张三",
			firstChatAt: 1,
			lastChatAt: 2,
		},
		{
			id: "ct_p02",
			channelId: "bot_bbb",
			kind: "person",
			userId: "lisi",
			remark: "李四",
			firstChatAt: 1,
			lastChatAt: 3,
		},
		{
			id: "ct_g01",
			channelId: "bot_aaa",
			kind: "group",
			chatId: "wr_group01",
			firstChatAt: 1,
			lastChatAt: 4,
		},
	];
	const loadContacts = mock(async () => {});
	const store = { contacts, loadContacts };
	const useContactsStore = (sel?: (s: typeof store) => unknown) =>
		sel ? sel(store) : store;
	useContactsStore.getState = () => store;
	return { useContactsStore };
});

// 渲染 SkillSuggestTextarea 需要 skills store；提供空列表即可（$ 弹窗不开时用不到）。
// 组件按 zustand selector 用法取 s.skills，mock 需透传 sel 参数；
// SkillSuggestTextarea 的 useEffect 还会调 useSkillsStore.getState().load()。
mock.module("../../../store/skills", () => {
	const store = {
		skills: [],
		allSkills: [],
		load: () => {},
	};
	const useSkillsStore = (sel: (s: any) => unknown) => sel(store);
	useSkillsStore.getState = () => store;
	return { useSkillsStore };
});

beforeEach(() => {
	cleanup();
});

describe("TaskPromptComposer", () => {
	test("渲染输入框与 $ / @ 提示", () => {
		render(<TaskPromptComposer value="" onChange={() => {}} />);
		expect(screen.getByPlaceholderText(/让智能体/)).toBeTruthy();
		// 提示行中的 $ 与 @ 标记（各自独立 <strong>，文本严格匹配）
		expect(screen.getByText("$")).toBeTruthy();
		expect(screen.getByText("@")).toBeTruthy();
	});

	test("输入 @ 弹出联系人列表（仅 person，按渠道分组显示渠道名）", () => {
		render(<TaskPromptComposer value="推送 @" onChange={() => {}} />);
		expect(screen.getByText("张三")).toBeTruthy();
		expect(screen.getByText("李四")).toBeTruthy();
		// 渠道名分组展示（分组标题含 emoji，用正则匹配）
		expect(screen.getByText(/企微/)).toBeTruthy();
		expect(screen.getByText(/飞书/)).toBeTruthy();
		// 群聊联系人（kind=group）不展示——@ 目标是人
		expect(screen.queryByText("wr_group01")).toBeNull();
	});

	test("选中联系人后把光标前的 @ 替换为 @ct_xxx（联系人 id）", () => {
		const onChange = mock();
		render(<TaskPromptComposer value="推送 @" onChange={onChange} />);
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		// 光标置于末尾（@ 之后），模拟真实输入
		textarea.setSelectionRange(4, 4);
		fireEvent.keyUp(textarea, { key: "@" });
		fireEvent.click(screen.getByText("张三"));
		expect(onChange).toHaveBeenCalledWith("推送 @ct_p01 ");
	});

	test("Escape 键关闭联系人选择器", () => {
		render(<TaskPromptComposer value="推送 @" onChange={() => {}} />);
		const textarea = screen.getByRole("textbox");
		expect(screen.getByTestId("channel-picker")).toBeTruthy();
		fireEvent.keyDown(textarea, { key: "Escape" });
		expect(screen.queryByTestId("channel-picker")).toBeNull();
	});

	test("点击外部关闭联系人选择器", () => {
		render(<TaskPromptComposer value="推送 @" onChange={() => {}} />);
		expect(screen.getByTestId("channel-picker")).toBeTruthy();
		// 模拟点击容器外部
		fireEvent.mouseDown(document.body);
		expect(screen.queryByTestId("channel-picker")).toBeNull();
	});

	test("继续输入（@ 后追加文本）自动收起选择器", () => {
		render(<TaskPromptComposer value="推送 @张" onChange={() => {}} />);
		// value 末尾不再是 @ → 派生状态自动收起
		expect(screen.queryByTestId("channel-picker")).toBeNull();
	});
});
