// TaskPromptComposer 组件测试（bun:test，匹配本项目既有组件测试约定）。
// v2：contenteditable chip 输入框（ComposerTextarea + toPromptHtml）。
// - @ 联系人：chip 显示人名，存储形态 @im-push-to(bot,ct)（kernel 执行时解析）
// - $ 技能：chip 显示技能名，存储形态 $[技能名]（kernel 执行时任意位置展开）
// 本文件测 TaskPromptComposer 自己的职责：双弹窗触发/插入/关闭、chip 渲染、失效联系人灰化。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TaskPromptComposer } from "../TaskPromptComposer";

// channels store：提供渠道名（供 @ 弹窗按渠道分组展示）
mock.module("../../../store/channels", () => ({
	useChannelsStore: () => ({
		bots: [
			{ id: "ch_aaa", name: "企微", status: "connected" },
			{ id: "ch_bbb", name: "飞书", status: "connected" },
		],
	}),
}));

// contacts store：提供 person 联系人（通讯录），供 @ 弹窗选择与 chip 名字解析。
// 组件无参调用 useContactsStore() 取整个 state，也按 zustand selector 取子集，mock 需两者都支持。
mock.module("../../../store/contacts", () => {
	const contacts = [
		{
			id: "ct_p01",
			channelId: "ch_aaa",
			kind: "person",
			userId: "zhangsan",
			remark: "张三",
			firstChatAt: 1,
			lastChatAt: 2,
		},
		{
			id: "ct_p02",
			channelId: "ch_bbb",
			kind: "person",
			userId: "lisi",
			remark: "李四",
			firstChatAt: 1,
			lastChatAt: 3,
		},
		{
			id: "ct_g01",
			channelId: "ch_aaa",
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

// skills store：$ 技能弹窗数据源（与 SkillSuggestTextarea 同源；非空才渲染弹窗）
mock.module("../../../store/skills", () => {
	const store = {
		skills: [
			{ name: "日报生成", description: "生成日报" },
			{ name: "周报生成", description: "生成周报" },
		],
		allSkills: [
			{ name: "日报生成", description: "生成日报" },
			{ name: "周报生成", description: "生成周报" },
		],
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
		expect(screen.getByTestId("task-prompt-input")).toBeTruthy();
		// placeholder 为 CSS 伪元素（contenteditable 无 placeholder 属性），断言 data 属性
		expect(
			screen.getByTestId("task-prompt-input").getAttribute("data-placeholder"),
		).toContain("让智能体");
		expect(screen.getByText("$")).toBeTruthy();
		expect(screen.getByText("@")).toBeTruthy();
	});

	test("value 末尾 @ → 弹出联系人列表（person + group，按渠道分组，testid=contact-picker）", () => {
		render(<TaskPromptComposer value="推送 @" onChange={() => {}} />);
		expect(screen.getByTestId("contact-picker")).toBeTruthy();
		expect(screen.getByText("张三")).toBeTruthy();
		expect(screen.getByText("李四")).toBeTruthy();
		expect(screen.getByText(/企微/)).toBeTruthy();
		expect(screen.getByText(/飞书/)).toBeTruthy();
		// 群聊联系人（kind=group）也展示，群名取 chatId 前 8 位
		expect(screen.getByText("wr_group")).toBeTruthy();
		// 人/群图标为 SVG（user/users），非 emoji
		expect(screen.getByTestId("contact-kind-group")).toBeTruthy();
		expect(screen.getAllByTestId("contact-kind-person").length).toBeGreaterThan(
			0,
		);
	});

	test("选中联系人（person）后末尾 @ 替换为 @im-push-to(bot,ct) 标记", () => {
		const onChange = mock();
		render(<TaskPromptComposer value="推送 @" onChange={onChange} />);
		fireEvent.click(screen.getByTestId("contact-item-ct_p01"));
		expect(onChange).toHaveBeenCalledWith("推送 @im-push-to(ch_aaa,ct_p01) ");
	});

	test("选中群联系人后末尾 @ 替换为 @im-push-to(bot,ct) 标记", () => {
		const onChange = mock();
		render(<TaskPromptComposer value="推送 @" onChange={onChange} />);
		fireEvent.click(screen.getByTestId("contact-item-ct_g01"));
		expect(onChange).toHaveBeenCalledWith("推送 @im-push-to(ch_aaa,ct_g01) ");
	});

	test("value 末尾 $ → 弹出技能弹窗（testid=skill-picker，通用 QuickInvokeMenu 渲染），点击选中插入 $[技能名]", () => {
		const onChange = mock();
		render(<TaskPromptComposer value="执行 $" onChange={onChange} />);
		expect(screen.getByTestId("skill-picker")).toBeTruthy();
		// 列表体为通用 QuickInvokeMenu：按技能名文本定位点击
		fireEvent.click(screen.getByText("日报生成"));
		expect(onChange).toHaveBeenCalledWith("执行 $[日报生成] ");
	});

	test("技能弹窗键盘导航：ArrowDown 移高亮、Enter 选中插入", () => {
		const onChange = mock();
		render(<TaskPromptComposer value="执行 $" onChange={onChange} />);
		const input = screen.getByTestId("task-prompt-input");
		// 第二项（ArrowDown 一次）→ Enter 选中
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenCalledWith("执行 $[周报生成] ");
	});

	test("存储形态的联系人标记渲染为 chip（显示人名）", () => {
		render(
			<TaskPromptComposer
				value="推给 @im-push-to(ch_aaa,ct_p01) 完成"
				onChange={() => {}}
			/>,
		);
		const chip = document.querySelector(
			'[data-token="@im-push-to(ch_aaa,ct_p01)"]',
		);
		expect(chip).toBeTruthy();
		expect(chip!.textContent).toContain("张三");
		expect(chip!.className).toContain("chip-im");
		// 单人图标（user：1 个 path）
		expect(chip!.querySelectorAll("svg path").length).toBe(1);
	});

	test("存储形态的群联系人标记渲染为 chip（显示 chatId 前 8 位）", () => {
		render(
			<TaskPromptComposer
				value="推给 @im-push-to(ch_aaa,ct_g01) 完成"
				onChange={() => {}}
			/>,
		);
		const chip = document.querySelector(
			'[data-token="@im-push-to(ch_aaa,ct_g01)"]',
		);
		expect(chip).toBeTruthy();
		expect(chip!.textContent).toContain("wr_group");
		expect(chip!.className).toContain("chip-im");
		// 多人图标（users：3 个 path）
		expect(chip!.querySelectorAll("svg path").length).toBe(3);
	});

	test("存储形态的技能标记渲染为 chip-skill", () => {
		render(
			<TaskPromptComposer value="执行 $[日报生成] 跑" onChange={() => {}} />,
		);
		const chip = document.querySelector('[data-token="$[日报生成]"]');
		expect(chip).toBeTruthy();
		expect(chip!.className).toContain("chip-skill");
	});

	test("失效联系人（store 查无）灰化显示 id", () => {
		render(
			<TaskPromptComposer
				value="推给 @im-push-to(ch_aaa,ct_gone)"
				onChange={() => {}}
			/>,
		);
		const chip = document.querySelector('[data-token^="@im-push-to"]');
		expect(chip!.className).toContain("chip-im-invalid");
		expect(chip!.textContent).toContain("ct_gone");
	});

	test("Escape 关闭联系人选择器", () => {
		render(<TaskPromptComposer value="推送 @" onChange={() => {}} />);
		expect(screen.getByTestId("contact-picker")).toBeTruthy();
		fireEvent.keyDown(screen.getByTestId("task-prompt-input"), {
			key: "Escape",
		});
		expect(screen.queryByTestId("contact-picker")).toBeNull();
	});

	test("点击外部关闭联系人选择器", () => {
		render(<TaskPromptComposer value="推送 @" onChange={() => {}} />);
		expect(screen.getByTestId("contact-picker")).toBeTruthy();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByTestId("contact-picker")).toBeNull();
	});

	test("value 末尾非触发符 → 双弹窗均不显示", () => {
		render(<TaskPromptComposer value="推送 @张 执行 $日" onChange={() => {}} />);
		expect(screen.queryByTestId("contact-picker")).toBeNull();
		expect(screen.queryByTestId("skill-picker")).toBeNull();
	});
});

test("粘贴含 chip token 的富文本：onChange 收到 token 原文（跨输入框复制后重渲染成 chip）", () => {
    const onChange = mock();
    render(<TaskPromptComposer value="已有内容" onChange={onChange} />);
    const textbox = screen.getByTestId("task-prompt-input") as HTMLElement;
    fireEvent.paste(textbox, {
        clipboardData: {
            files: [],
            getData: (type: string) =>
                type === "text/html"
                    ? "$[using-git-worktrees] 导弹发射地方"
                    : "$[using-git-worktrees] 导弹发射地方",
        },
    });
    // onChange 收到合入 token 的完整文本（受控层会重渲染成 chip）
    expect(onChange).toHaveBeenCalledWith(
        "已有内容$[using-git-worktrees] 导弹发射地方",
    );
});
