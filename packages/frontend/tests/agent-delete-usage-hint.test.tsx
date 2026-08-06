import { test, expect, mock, describe, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { AgentConfig } from "@wa-pi/shared";

// Mock api-client：根据 agent 名返回不同的引用计数，模拟 Task 7 的
// GET /api/channels/agent-usage/:agentName 响应。
// 「前端开发者」被 2 个机器人引用；其它返回 count=0；可注入 throw 模拟失败。
const agentUsagePath = (name: string) =>
	`/api/channels/agent-usage/${encodeURIComponent(name)}`;

let failNextUsage = false;
const usageMap: Record<string, { count: number; channelNames: string[] }> = {
	前端开发者: { count: 2, channelNames: ["客服机器人", "测试机器人"] },
};

mock.module("../src/api-client", () => ({
	api: {
		get: async (path: string) => {
			if (path.startsWith("/api/channels/agent-usage/")) {
				if (failNextUsage) {
					failNextUsage = false;
					throw new Error("network");
				}
				const name = decodeURIComponent(
					path.replace("/api/channels/agent-usage/", ""),
				);
				return usageMap[name] ?? { count: 0, channelNames: [] };
			}
			return {};
		},
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
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

const { AgentListSection } = await import("../src/components/AgentListSection");
const { AgentGalleryModal } = await import("../src/components/AgentGalleryModal");
const { useAgentsStore } = await import("../src/store/agents");
const { useProjectsStore } = await import("../src/store/projects");
const { useSessionStore } = await import("../src/store/session");

const agent = (name: string): AgentConfig => ({
	displayName: name,
	avatar: "🤖",
	avatarColor: "#000-#111",
	description: "",
	model: "m",
	thinking: "medium",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
});

const realDeleteAgent = useAgentsStore.getState().deleteAgent;

function seed(names: string[]) {
	useAgentsStore.setState({
		list: names.map(agent),
		deleteAgent: realDeleteAgent,
	});
	useProjectsStore.setState({ sessions: [] });
	useSessionStore.setState({ statusBySession: {}, messagesBySession: {} });
}

const noop = () => {};

// 右键 → 删除 → 等二次确认弹窗出现并等异步 usage 拉取完成
async function openDeleteConfirm(testId: string) {
	fireEvent.contextMenu(screen.getByTestId(testId));
	fireEvent.click(screen.getByTestId("agent-ctx-delete"));
	await waitFor(() =>
		expect(screen.getByTestId("agent-delete-confirm")).toBeTruthy(),
	);
}

async function openGalleryDeleteConfirm(testId: string) {
	fireEvent.contextMenu(screen.getByTestId(testId));
	fireEvent.click(screen.getByTestId("gallery-ctx-delete"));
	await waitFor(() =>
		expect(screen.getByTestId("gallery-delete-confirm")).toBeTruthy(),
	);
}

// 上下文菜单绑了 setTimeout(0) 的 document click 监听，跨用例不关会泄漏 portal；
// 每个用例结尾显式 cleanup 兜底（同 AgentListSection.test.tsx 模式）。
afterEach(() => {
	cleanup();
	failNextUsage = false;
});

describe("智能体删除确认：渠道引用提示（AgentListSection）", () => {
	beforeEach(() => seed([]));

	test("被渠道引用的智能体 → 确认文案含机器人引用提示", async () => {
		seed(["前端开发者", "后端架构师"]);
		render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
		await openDeleteConfirm("agent-前端开发者");
		// 异步拉取 usage 完成后提示文本出现
		await waitFor(() => {
			const msg = screen.getByTestId("confirm-dialog").textContent ?? "";
			expect(msg).toContain("2 个机器人");
			expect(msg).toContain("客服机器人");
			expect(msg).toContain("测试机器人");
			expect(msg).toContain("默认智能体");
		});
	});

	test("无渠道引用的智能体 → 确认文案不含机器人提示（原样）", async () => {
		seed(["前端开发者", "后端架构师"]);
		render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
		await openDeleteConfirm("agent-后端架构师");
		// usage.count=0，等异步落定后文案不含「机器人」
		await waitFor(() => {
			const msg = screen.getByTestId("confirm-dialog").textContent ?? "";
			expect(msg).toContain("删除智能体「后端架构师」");
			expect(msg).not.toContain("机器人");
			expect(msg).not.toContain("默认智能体");
		});
	});

	test("usage 接口失败 → 不崩溃，按原文案显示（无提示）", async () => {
		seed(["前端开发者"]);
		failNextUsage = true;
		render(<AgentListSection onChatWith={noop} onEdit={noop} onMore={noop} />);
		await openDeleteConfirm("agent-前端开发者");
		// 等一拍确保 reject 已被消费
		await new Promise((r) => setTimeout(r, 10));
		const msg = screen.getByTestId("confirm-dialog").textContent ?? "";
		expect(msg).toContain("删除智能体「前端开发者」");
		expect(msg).not.toContain("机器人");
	});
});

describe("智能体删除确认：渠道引用提示（AgentGalleryModal）", () => {
	beforeEach(() => seed([]));

	test("被渠道引用的智能体 → 宫格删除确认含机器人引用提示", async () => {
		seed(["前端开发者"]);
		render(
			<AgentGalleryModal
				onClose={noop}
				onChatWith={noop}
				onEdit={noop}
				onCreated={noop}
			/>,
		);
		await openGalleryDeleteConfirm("gallery-card-前端开发者");
		await waitFor(() => {
			const msg = screen.getByTestId("confirm-dialog").textContent ?? "";
			expect(msg).toContain("2 个机器人");
			expect(msg).toContain("默认智能体");
		});
	});
});
