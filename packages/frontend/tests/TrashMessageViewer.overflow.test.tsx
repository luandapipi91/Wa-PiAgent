// 回收站会话详情长内容换行回归测试。
// 修复前：长 URL / 连续英文 / 代码行无换行点，撑破 max-w-[80%] → 横向滚动。
// 修复后：消息气泡加 break-words + overflow-hidden，代码块 overflow-x-auto，滚动容器 overflow-x-hidden。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import type { AgentMessage } from "@wa-pi/shared";

// mock api.get 返回含长内容的消息
const fakeMessages = {
	messages: [
		{
			message: {
				role: "user",
				content:
					"https://example.com/very/long/url/that/should/not/overflow/the/container/boundary/at/all/costs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				timestamp: 1,
			} as AgentMessage,
		},
		{
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "正常文本",
					},
				],
				timestamp: 2,
				model: "m",
				stopReason: "end_turn",
			} as AgentMessage,
			agentName: "助手",
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

// i18n mock
mock.module("../src/i18n/useTranslation", () => ({
	useTranslation: () => ({ t: (k: string) => k }),
}));

import { TrashMessageViewer } from "../src/components/TrashMessageViewer";

beforeEach(() => {
	document.body.innerHTML = "";
});

test("长 URL 消息气泡含 break-words + overflow-hidden 防止横向溢出", async () => {
	render(<TrashMessageViewer sessionId="s1" onBack={() => {}} />);

	// 等待消息加载完成
	await waitFor(() => {
		expect(screen.getByText("正常文本")).toBeTruthy();
	});

	// 找到用户消息气泡（含长 URL）
	const longUrlEl = screen.getByText(/example\.com\/very\/long/);
	expect(longUrlEl).toBeTruthy();

	// 气泡容器（max-w-[80%]）应有 break-words + overflow-hidden 防止横向溢出
	// 遍历祖先找到含 max-w-[80%] 的气泡 div
	let el: HTMLElement | null = longUrlEl as HTMLElement;
	let bubble: HTMLElement | null = null;
	while (el) {
		if (el.className?.includes("max-w-[80%]")) {
			bubble = el;
			break;
		}
		el = el.parentElement;
	}
	expect(bubble).toBeTruthy();
	expect(bubble!.className.includes("break-words")).toBe(true);
	expect(bubble!.className.includes("overflow-hidden")).toBe(true);
});

test("代码块容器含 overflow-x-auto（内部滚动而非撑破）", async () => {
	// 用含代码块的消息测试
	const codeMessages = {
		messages: [
			{
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "```js\nconst x = 'very_long_string_that_exceeds_container_width_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n```",
						},
					],
					timestamp: 1,
					model: "m",
					stopReason: "end_turn",
				} as AgentMessage,
				agentName: "助手",
			},
		],
	};
	// 覆盖 mock
	const { api } = await import("../src/api-client");
	(api.get as any) = async () => codeMessages;

	render(<TrashMessageViewer sessionId="s2" onBack={() => {}} />);

	await waitFor(() => {
		expect(screen.getByText(/very_long_string/)).toBeTruthy();
	});

	// prose 容器应有 [&_pre]:overflow-x-auto
	const proseEl = screen.getByText(/very_long_string/).closest(".prose");
	expect(proseEl?.className.includes("[&_pre]:overflow-x-auto")).toBe(true);
});
