import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useSessionStore } from "../src/store/session";
import type { AskParams } from "@wa-pi/shared";

// mock api-client：get 返回后端 pending 列表（double check 数据源）
let pendingIds: string[] = [];
const getCalls: string[] = [];
// 竞态模拟：首次核对后才「注册完成」（pendingIds 在第一次调用后翻转）
let flipAfterFirstCall = false;

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			getCalls.push(path);
			const pending = [...pendingIds];
			if (flipAfterFirstCall && getCalls.length === 1) pendingIds = ["tc1"];
			return Promise.resolve({ pending });
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
		flipAfterFirstCall = false;
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

	it("本地有、后端已无的 ask → 宽限复查仍 miss，卡片显示提问已失效且提交禁用", async () => {
		pendingIds = []; // 后端已无 tc1（已取消/会话切换/重启残留），复查也没有
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		// 失效判定有竞态宽限（~500ms 后复查），用 waitFor 等失效态出现
		await waitFor(
			() => expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy(),
			{ timeout: 3000 },
		);
		fireEvent.click(screen.getByText("PostgreSQL"));
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("首次核对 miss 但宽限复查时已注册 → 不误判失效（消息先于 bridge 注册的竞态防护）", async () => {
		pendingIds = []; // 首次核对时后端尚未注册（竞态窗口）
		flipAfterFirstCall = true; // 复查时已注册
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		// 等宽限复查发生（第二次 /asks 调用）
		await waitFor(
			() =>
				expect(
					getCalls.filter((p) => p.includes("/api/sessions/s1/asks")).length,
				).toBeGreaterThanOrEqual(2),
			{ timeout: 3000 },
		);
		// 复查命中注册 → 不显示失效，提交可用
		expect(screen.queryByText("提问已失效", { exact: false })).toBeNull();
		fireEvent.click(screen.getByText("PostgreSQL"));
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});
});
