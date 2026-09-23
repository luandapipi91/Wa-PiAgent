// 归档会话查看器「只渲染对话正文」回归测试。
// 修复前：role:"toolResult" 的消息被当成助手正文——工具原始输出（ls / memory_search 等）进气泡，
// 且经 <Markdown> 渲染，输出里的 "-" 行触发 markdown setext 标题，整段变 <h2> 大字。
// 修复后：非 user/assistant 的消息（toolResult / system / custom / compactionSummary）一律不渲染。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import type { AgentMessage } from "@wa-pi/shared";

// 含 "-" 独立行的工具输出：在 markdown 下会把上一段变成 setext h2
const LS_OUTPUT = [
	"total 7912",
	"drwxr-xr-x   43 co  staff    1376 Sep 23 10:20 .",
	"---",
	"-rw-------    1 co  staff    1297 Sep 18 17:13 auth.json",
].join("\n");

const fakeMessages = {
	messages: [
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "把启动器的应用移除" }],
				timestamp: 1,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: "助手正文回复" }],
				timestamp: 2,
				model: "m",
				stopReason: "end_turn",
			} as AgentMessage,
			agentName: "高级项目经理",
		},
		{
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: LS_OUTPUT }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
			agentName: "高级项目经理",
		},
		{
			message: {
				role: "system",
				content: "系统提示不该出现",
				timestamp: 4,
			} as AgentMessage,
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

test("工具结果与系统消息不渲染；只显示用户消息与助手正文", async () => {
	const { container } = render(
		<TrashMessageViewer sessionId="s1" onBack={() => {}} onClose={() => {}} />,
	);

	await waitFor(() => {
		expect(screen.getByText("助手正文回复")).toBeTruthy();
	});

	// 用户消息与助手正文可见
	expect(screen.getByText("把启动器的应用移除")).toBeTruthy();

	// 工具原始输出不得出现在界面上
	expect(screen.queryByText(/total 7912/)).toBeNull();
	expect(screen.queryByText(/auth\.json/)).toBeNull();
	// 系统消息不得渲染
	expect(screen.queryByText(/系统提示不该出现/)).toBeNull();
});

test("工具输出不得被 markdown 渲染成标题（页面无 h1-h3 大字）", async () => {
	const { container } = render(
		<TrashMessageViewer sessionId="s1" onBack={() => {}} onClose={() => {}} />,
	);

	await waitFor(() => {
		expect(screen.getByText("助手正文回复")).toBeTruthy();
	});

	expect(container.querySelectorAll("h1,h2,h3").length).toBe(0);
});
