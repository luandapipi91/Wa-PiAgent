// 归档会话查看器「按轮聚合、只显示最终正文」回归测试。
//
// 背景（2026-10-10 用户反馈）：查看归档会话时，工具调用循环里每条 assistant 消息
// 的过渡说明（如「先把上次测试记录读全，再做写入回环验证。」）都被渲染成独立气泡，
// 观感上「思考过程全显示出来了」，最终回复淹没在中间气泡里。
// 期望：按用户消息分轮，每轮只渲染轮内最后一个非空 text（最终回复），聚合为一个气泡；
// 轮内只有 thinking（无 text，被截断的收尾）不渲染 assistant 气泡。
// 结构依据真实归档会话（s-117dcbe1）：assistant 消息形如
// [thinking(数万字), text(几十~几百字), toolCall...]，toolResult 为独立 role 消息。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import type { AgentMessage } from "@wa-pi/shared";

const fakeMessages = {
	messages: [
		// 第一轮：用户提问 → 三条 assistant（工具循环：中间过渡 text ×2 + 最终 text）→ toolResult 若干
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "测试记忆" }],
				timestamp: 1,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内部思考甲，绝不能出现在页面上" },
					{ type: "text", text: "过渡说明一：先把上次测试记录读全。" },
					{ type: "toolCall", id: "c1", name: "memory_search" },
				],
				timestamp: 2,
			} as AgentMessage,
			agentName: "高级项目经理",
		},
		{
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "memory_search",
				content: [{ type: "text", text: "工具输出，不该出现" }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内部思考乙，绝不能出现在页面上" },
					{ type: "text", text: "过渡说明二：再补几条精确查询。" },
					{ type: "toolCall", id: "c2", name: "memory_add" },
				],
				timestamp: 4,
			} as AgentMessage,
			agentName: "高级项目经理",
		},
		{
			message: {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "memory_add",
				content: [{ type: "text", text: "工具输出，不该出现" }],
				isError: false,
				timestamp: 5,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内部思考丙，绝不能出现在页面上" },
					{ type: "text", text: "第一轮的最终回复正文。" },
				],
				timestamp: 6,
			} as AgentMessage,
			agentName: "高级项目经理",
		},
		// 第二轮：用户追问 → assistant 只到 thinking+toolCall+toolResult（无 text 的中间态）
		// → 收尾 assistant 只有 thinking（无 text，截断场景）→ 本轮不应出现 assistant 气泡
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "测试读取" }],
				timestamp: 7,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内部思考丁" },
					{ type: "toolCall", id: "c3", name: "memory_search" },
				],
				timestamp: 8,
			} as AgentMessage,
			agentName: "高级项目经理",
		},
		{
			message: {
				role: "toolResult",
				toolCallId: "c3",
				toolName: "memory_search",
				content: [{ type: "text", text: "工具输出，不该出现" }],
				isError: false,
				timestamp: 9,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "未完成的收尾思考，无正文" },
				],
				timestamp: 10,
			} as AgentMessage,
			agentName: "高级项目经理",
		},
	],
};

mock.module("../src/api-client", () => ({
	api: {
		get: async () => fakeMessages,
	},
	ApiError: class ApiError extends Error {
		status = 0;
	},
}));

mock.module("../src/store/trash", () => ({
	useTrashStore: () => ({
		getState: () => ({ restore: async () => {} }),
	}),
}));

mock.module("../src/i18n/useTranslation", () => ({
	useTranslation: () => ({ t: (k: string) => k }),
}));

import { TrashMessageViewer } from "../src/components/TrashMessageViewer";

beforeEach(() => {
	document.body.innerHTML = "";
});

test("一轮只显示最终回复：过渡说明与 thinking 不出现，最终正文聚合成一个气泡", async () => {
	render(<TrashMessageViewer sessionId="s-test" onBack={() => {}} onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByText("测试记忆")).toBeTruthy(),
	);
	const text = document.body.textContent ?? "";
	// 最终回复在
	expect(text).toContain("第一轮的最终回复正文。");
	// 中间过渡说明不出现
	expect(text).not.toContain("过渡说明一");
	expect(text).not.toContain("过渡说明二");
	// thinking 不出现
	expect(text).not.toContain("内部思考甲");
	expect(text).not.toContain("未完成的收尾思考");
	// 工具输出不出现
	expect(text).not.toContain("工具输出，不该出现");
});

test("聚合后助手气泡数量 = 有最终正文的轮数（本例两轮 → 1 个助手气泡）", async () => {
	render(<TrashMessageViewer sessionId="s-test" onBack={() => {}} onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByText("测试记忆")).toBeTruthy(),
	);
	// 助手气泡带 agentName 标头；本例只有第一轮有最终正文 → 恰 1 个
	expect(screen.getAllByText("高级项目经理")).toHaveLength(1);
	// 用户气泡 2 个（每轮一条）
	expect(screen.getByText("测试记忆")).toBeTruthy();
	expect(screen.getByText("测试读取")).toBeTruthy();
});
