import { describe, it, expect, mock, beforeEach } from "bun:test";
import { act, render, screen, fireEvent, waitFor, renderHook } from "@testing-library/react";
import { useSessionStore } from "../src/store/session";
import { useDismissedAskStore, useIsBlocked } from "../src/store/ask";
import type { AskParams } from "@wa-pi/shared";

// mock api-client：get 返回后端 pending 列表（double check 数据源）
let pendingIds: string[] = [];
// 双检状态（P0-1）：缺省由 pendingIds 推导，保留旧用例的写法
let askStates: Array<{ toolCallId: string; state: "pending" | "answered" | "cancelled" }> | null = null;
// 提交请求的可注入实现（默认成功；用例可改成立即翻转双检状态）
let postImpl: (path: string, body?: any) => Promise<any> = async () => ({});
const getCalls: string[] = [];
// 竞态模拟：首次核对后才「注册完成」（pendingIds 在第一次调用后翻转）
let flipAfterFirstCall = false;

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			getCalls.push(path);
			const pending = [...pendingIds];
			if (flipAfterFirstCall && getCalls.length === 1) pendingIds = ["tc1"];
			return Promise.resolve(
				askStates
					? { pending, states: askStates.map((e) => ({ ...e })) }
					: { pending },
			);
		},
		post: (path: string, body?: any) => postImpl(path, body),
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

/** 追加一条 toolResult（模拟内核对 ask 的应答/取消落盘） */
function appendToolResult(sessionId: string, toolCallId: string) {
	useSessionStore.setState((s) => ({
		messagesBySession: {
			...s.messagesBySession,
			[sessionId]: [
				...(s.messagesBySession[sessionId] ?? []),
				{
					message: {
						role: "toolResult",
						toolCallId,
						toolName: "ask_user_question",
						content: [{ type: "text", text: "用户取消了提问" }],
						isError: false,
						timestamp: 2,
					},
				},
			],
		},
	}));
}

describe("AskDock double check", () => {
	beforeEach(() => {
		localStorage.clear();
		useSessionStore.setState({ messagesBySession: {} });
		useDismissedAskStore.setState({ bySession: {} });
		pendingIds = [];
		getCalls.length = 0;
		flipAfterFirstCall = false;
		askStates = null;
		postImpl = async () => ({});
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

	it("本地有、后端已无的 ask → 宽限复查仍 miss，卡片转只读终态（不再渲染可点表单）", async () => {
		pendingIds = []; // 后端已无 tc1（已取消/会话切换/重启残留），复查也没有
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		// 失效判定有竞态宽限（~500ms 后复查），用 waitFor 等失效态出现
		await waitFor(
			() =>
				expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy(),
			{ timeout: 3000 },
		);
		// 只读：选项与提交按钮都不再存在，避免"点了没反应"
		expect(screen.queryByText("PostgreSQL")).toBeNull();
		expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
		expect(screen.getByRole("button", { name: "重新发起" })).toBeTruthy();
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

describe("AskDock 失效卡片本地关闭", () => {
	beforeEach(() => {
		localStorage.clear();
		useSessionStore.setState({ messagesBySession: {} });
		useDismissedAskStore.setState({ bySession: {} });
		pendingIds = [];
		getCalls.length = 0;
		flipAfterFirstCall = false;
		askStates = null;
		postImpl = async () => ({});
	});

	it("失效卡片点取消 → 卡片消失、输入不再被阻塞", async () => {
		pendingIds = []; // 后端已无 tc1（已取消/重启残留）
		seedPendingAsk("s1");
		const { result } = renderHook(() => useIsBlocked("s1"));
		render(<AskDock sessionId="s1" />);
		await waitFor(
			() =>
				expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy(),
			{ timeout: 3000 },
		);
		expect(result.current).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "关闭" }));

		expect(screen.queryByTestId("ask-card-tc1")).toBeNull();
		await waitFor(() => expect(result.current).toBe(false));
	});

	it("关闭标记在 toolResult 到达后回收（ask 真正从 pending 消失）", async () => {
		pendingIds = [];
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await waitFor(
			() =>
				expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy(),
			{ timeout: 3000 },
		);
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(
			useDismissedAskStore.getState().isDismissed("s1", "tc1"),
		).toBe(true);

		// 内核对账/应答落盘 → ask 从 pending 派生中消失 → 关闭标记回收
		act(() => appendToolResult("s1", "tc1"));
		await waitFor(() =>
			expect(
				useDismissedAskStore.getState().isDismissed("s1", "tc1"),
			).toBe(false),
		);
	});

	it("折叠便签失效 → 显示关闭按钮，点击后便签消失", async () => {
		localStorage.setItem("wa-pi:ask-dock-expanded", "0");
		pendingIds = [];
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		const dismiss = await waitFor(
			() => screen.getByTestId("ask-quick-dismiss"),
			{ timeout: 3000 },
		);
		fireEvent.click(dismiss);
		expect(screen.queryByTestId("ask-quick-bar")).toBeNull();
	});
});

describe("AskDock 折叠便签 + 悬浮展开", () => {
	beforeEach(() => {
		localStorage.clear();
		useSessionStore.setState({ messagesBySession: {} });
		useDismissedAskStore.setState({ bySession: {} });
		pendingIds = ["tc1"];
		getCalls.length = 0;
		flipAfterFirstCall = false;
		askStates = null;
		postImpl = async () => ({});
	});

	it("默认展开（无 localStorage 记录）：渲染 AskFormCard 悬浮弹窗", async () => {
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		expect(screen.getByTestId("ask-card-tc1")).toBeTruthy();
		expect(screen.queryByTestId("ask-quick-bar")).toBeNull();
	});

	it("点「收起」回便签态，并写入 localStorage（全局持久化）", async () => {
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		expect(screen.getByTestId("ask-quick-bar")).toBeTruthy();
		expect(screen.queryByTestId("ask-card-tc1")).toBeNull();
		expect(localStorage.getItem("wa-pi:ask-dock-expanded")).toBe("0");
	});

	it("localStorage 记录为收起 → 重挂载仍收起（记住上次状态）", async () => {
		localStorage.setItem("wa-pi:ask-dock-expanded", "0");
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		expect(screen.getByTestId("ask-quick-bar")).toBeTruthy();
		expect(screen.queryByTestId("ask-card-tc1")).toBeNull();
	});

	it("点「展开」→ 悬浮弹窗容器有 absolute 类（不挤压文档流）", async () => {
		localStorage.setItem("wa-pi:ask-dock-expanded", "0");
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(
			() => expect(screen.getByTestId("ask-card-tc1")).toBeTruthy(),
			{ timeout: 1000 },
		);
		expect(localStorage.getItem("wa-pi:ask-dock-expanded")).toBe("1");
		const dock = screen.getByTestId("ask-dock-s1");
		expect(dock.className).toContain("relative");
		const layer = dock.querySelector("[data-testid='ask-float-layer']");
		expect(layer).toBeTruthy();
		// 弹窗限高：内部滚动，避免顶部超出视口/消息区（紧贴输入框上方）
		expect((layer as HTMLElement).className).toContain("max-h");
		expect((layer as HTMLElement).className).toContain("overflow");
		// 收起入口已移到卡片 footer；弹窗底部不再有独立收起按钮
		expect(dock.querySelector("[data-testid='ask-float-collapse']")).toBeNull();
	});

	it("多个 pending ask → 展开显示全部卡片", async () => {
		const askCall2 = {
			type: "toolCall",
			id: "tc2",
			name: "ask_user_question",
			arguments: {
				questions: [
					{
						question: "另一个问题?",
						header: "h",
						options: [
							{ label: "X", description: "x" },
							{ label: "Y", description: "y" },
						],
					},
				],
			},
		};
		seedPendingAsk("s1", [askCall, askCall2]);
		render(<AskDock sessionId="s1" />); // 默认展开 → 直接显示两个卡片
		await flush();
		await waitFor(
			() => expect(screen.getByTestId("ask-card-tc2")).toBeTruthy(),
			{ timeout: 1000 },
		);
	});

	it("便签选过旧 ask → 旧 ask 被回答、新 ask 到达 → 新 ask 卡片无预选注入、提交禁用", async () => {
		// ask1（tc1，选项 SQLite/PostgreSQL）：默认展开
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		expect(screen.getByTestId("ask-card-tc1")).toBeTruthy();

		// 收起 → 便签 → 点选「SQLite」（AskDock.quickSel 被写入）
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		expect(screen.getByTestId("ask-quick-bar")).toBeTruthy();
		fireEvent.click(screen.getByText("SQLite"));

		// 再展开：预选注入 ask1 卡片（SQLite 选中、提交可用）——确认复现前提成立
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(
			() => expect(screen.getByTestId("ask-card-tc1")).toBeTruthy(),
			{ timeout: 1000 },
		);
		expect(screen.getByText("SQLite").closest("button")?.className).toContain(
			"bg-accent-soft",
		);
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);

		// 旧 ask 被回答（store 清空）→ 新 ask（tc2，选项 X/Y）到达
		fireEvent.click(screen.getByRole("button", { name: "收起" }));
		seedPendingAsk("s1", []);
		await flush();
		pendingIds = ["tc2"]; // 后端 registry 同步为新 ask，避免 double check 误判失效
		const askCall2 = {
			type: "toolCall",
			id: "tc2",
			name: "ask_user_question",
			arguments: {
				questions: [
					{
						question: "另一个问题?",
						header: "h",
						options: [
							{ label: "X", description: "x" },
							{ label: "Y", description: "y" },
						],
					},
				],
			},
		};
		seedPendingAsk("s1", [askCall2]);
		await flush();

		// 展开 ask2：不得注入旧预选（X/Y 选项里没有 SQLite），提交必须禁用
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(
			() => expect(screen.getByTestId("ask-card-tc2")).toBeTruthy(),
			{ timeout: 1000 },
		);
		expect(
			(screen.getByRole("button", { name: "提交" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});

// ---- P0-1 回归：答完/取消不是"失效" ----
// 用户答完后 registry 条目立刻消失，但 toolResult 可能被同一批并行工具扣住数分钟。
// 过去前端只看 pending → 一律判失效，用户看到"我明明答了，界面说提问已失效且点不动"。
describe("AskDock 双检状态区分（answered/cancelled ≠ 失效）", () => {
	beforeEach(() => {
		localStorage.clear();
		useSessionStore.setState({ messagesBySession: {} });
		useDismissedAskStore.setState({ bySession: {} });
		pendingIds = [];
		getCalls.length = 0;
		flipAfterFirstCall = false;
		askStates = null;
		postImpl = async () => ({});
	});

	it("已答完（answered）→ 卡片收起，不提示失效，输入不再被阻塞", async () => {
		pendingIds = [];
		askStates = [{ toolCallId: "tc1", state: "answered" }];
		seedPendingAsk("s1");
		const { result } = renderHook(() => useIsBlocked("s1"));
		render(<AskDock sessionId="s1" />);
		await waitFor(
			() => expect(screen.queryByTestId("ask-card-tc1")).toBeNull(),
			{ timeout: 3000 },
		);
		expect(screen.queryByText("提问已失效", { exact: false })).toBeNull();
		await waitFor(() => expect(result.current).toBe(false));
	});

	it("已取消（cancelled）→ 同样收起，不提示失效", async () => {
		askStates = [{ toolCallId: "tc1", state: "cancelled" }];
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await waitFor(
			() => expect(screen.queryByTestId("ask-card-tc1")).toBeNull(),
			{ timeout: 3000 },
		);
		expect(screen.queryByText("提问已失效", { exact: false })).toBeNull();
	});

	it("查无此问（重启残留）→ 才是失效卡片", async () => {
		askStates = []; // states 里没有 tc1
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await waitFor(
			() =>
				expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy(),
			{ timeout: 3000 },
		);
	});

	it("提交成功后后端转为 answered → 卡片收起（不在 173s 回执窗口里显示失效）", async () => {
		pendingIds = ["tc1"];
		askStates = [{ toolCallId: "tc1", state: "pending" }];
		postImpl = async () => {
			// 提交被受理后：registry 条目已被消费，回执仍在并行批次里
			pendingIds = [];
			askStates = [{ toolCallId: "tc1", state: "answered" }];
			return {};
		};
		seedPendingAsk("s1");
		render(<AskDock sessionId="s1" />);
		await flush();
		fireEvent.click(screen.getByText("PostgreSQL"));
		fireEvent.click(screen.getByRole("button", { name: "提交" }));
		// 手动轮询（不用 waitFor：该用例的收尾由 effect 内的异步复检完成，
		// waitFor 的 act 包装会与它互等）
		let gone = false;
		for (let i = 0; i < 60 && !gone; i++) {
			await new Promise((r) => setTimeout(r, 20));
			gone = screen.queryByTestId("ask-card-tc1") === null;
		}
		expect(gone).toBe(true);
		expect(screen.queryByText("提问已失效", { exact: false })).toBeNull();
	});
});

// ---- P0-3 回归：关掉的卡片切会话回来不能复活 ----
describe("AskDock 关闭标记跨会话存活", () => {
	beforeEach(() => {
		localStorage.clear();
		useSessionStore.setState({ messagesBySession: {} });
		useDismissedAskStore.setState({ bySession: {} });
		pendingIds = [];
		getCalls.length = 0;
		flipAfterFirstCall = false;
		askStates = null;
		postImpl = async () => ({});
	});

	it("s1 关掉失效卡片 → 切到 s2 再切回 s1，卡片仍然关着", async () => {
		seedPendingAsk("s1");
		const { rerender } = render(<AskDock sessionId="s1" />);
		await waitFor(
			() =>
				expect(screen.getByText("提问已失效", { exact: false })).toBeTruthy(),
			{ timeout: 3000 },
		);
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
		expect(screen.queryByTestId("ask-card-tc1")).toBeNull();

		// 切到没有提问的 s2（AskDock 会用 s2 的空列表 prune）
		rerender(<AskDock sessionId="s2" />);
		await flush();
		// 切回 s1
		rerender(<AskDock sessionId="s1" />);
		await flush();
		expect(screen.queryByTestId("ask-card-tc1")).toBeNull();
	});
});
