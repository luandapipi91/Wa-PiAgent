// TaskPromptComposer 组件测试（bun:test，匹配本项目既有组件测试约定）。
// 简报原文使用 vitest + jest-dom，本仓库统一用 bun:test + @testing-library/react，
// 断言用 toBeTruthy；@ 触发逻辑因受控输入 + noop onChange 的测试约束，
// 采用「按下 @ 键即弹出渠道选择器」的实现，保证真实可用且可测。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TaskPromptComposer } from "../TaskPromptComposer";

// 把 channels store 替换成返回固定 bot 列表的假实现。
mock.module("../../../store/channels", () => ({
	useChannelsStore: () => ({
		bots: [
			{ id: "bot_aaa", name: "企微群", status: "connected" },
			{ id: "bot_bbb", name: "飞书群", status: "connected" },
			{ id: "bot_ccc", name: "未连接", status: "disconnected" },
		],
	}),
}));

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

	test("输入 @ 弹出 IM 渠道列表（仅已连接）", () => {
		render(<TaskPromptComposer value="" onChange={() => {}} />);
		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "推送 @" } });
		fireEvent.keyUp(textarea, { key: "@" });
		expect(screen.getByText("企微群")).toBeTruthy();
		expect(screen.getByText("飞书群")).toBeTruthy();
		// 未连接渠道不展示
		expect(screen.queryByText("未连接")).toBeNull();
	});

	test("选中渠道后把光标前的 @ 替换为 @bot_id", () => {
		const onChange = mock();
		render(<TaskPromptComposer value="推送 @" onChange={onChange} />);
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		// 光标置于末尾（@ 之后），模拟真实输入
		textarea.setSelectionRange(4, 4);
		fireEvent.keyUp(textarea, { key: "@" });
		fireEvent.click(screen.getByText("企微群"));
		expect(onChange).toHaveBeenCalledWith("推送 @bot_aaa ");
	});
});
