import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSessionStore } from "../src/store/session";
import type { AskParams } from "@wa-pi/shared";

// mock api-client：get 返回后端 pending 列表（double check 数据源）
let pendingIds: string[] = [];
const getCalls: string[] = [];

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			getCalls.push(path);
			return Promise.resolve({ pending: pendingIds });
		},
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
	ApiError: class extends Error {
		status: number;
		constructor(m: string, s: number) {
			super(m);
			this.status = s;
			this.name = "ApiError";
		}
	},
}));

import { AskDock } from "../src/components/ask/AskDock";

const params: AskParams = {
	questions: [
		{
			question: "数据存储方案?",
			header: "存储",
			options: [
				{ label: "SQLite", description: "轻量" },
				{ label: "PostgreSQL", description: "生产级" },
			],
		},
	],
};

const askCall = {
	type: "toolCall",
	id: "tc1",
	name: "ask_user_question",
	arguments: params,
};

function seedPendingAsk(sessionId: string, toolCalls: any[] = [askCall]) {
	useSessionStore.setState((s) => ({
		messagesBySession: {
			...s.messagesBySession,
			[sessionId]: [
				{
					message: {
						role: "assistant",
						content: toolCalls,
						model: "m",
						stopReason: "tool_use",
						timestamp: 1,
					},
					agentName: "dev",
				},
			],
		},
	}));
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("AskDock double check", () => {
	beforeEach(() => {
		useSessionStore.setState({ messagesBySession: {} });
		pendingIds = [];
		getCalls.length = 0;
	});

	it("渲染时向后端 /asks 核对（double check 请求发出）", async () => {
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		expect(getCalls.some((p) => p.includes("/api/sessions/s1/asks"))).toBe(
			true,
		);
	});

	it("后端仍 pending 的 ask → 正常卡片，可提交", async () => {
		pendingIds = ["tc1"];
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		expect(screen.queryByText("提问已失效", { exact: false })).toBeNull();
		fireEvent.click(screen.getByText("PostgreSQL"));
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("本地有、后端已无的 ask → 卡片显示提问已失效且提交禁用", async () => {
		pendingIds = []; // 后端已无 tc1（已取消/会话切换/重启残留）
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy();
		fireEvent.click(screen.getByText("PostgreSQL"));
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});
