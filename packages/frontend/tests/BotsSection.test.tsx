import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiCalls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
	api: {
		get: async (path: string) => {
			if (path === "/api/channels") return { channels: [] };
			if (path === "/api/channel-conversations") return { conversations: [] };
			return {};
		},
		post: async (path: string, body: any) => {
			apiCalls.push({ method: "POST", path, body });
			return { channels: [{ id: "ch_new", ...body.channel }] };
		},
		put: async () => ({ channels: [] }),
		del: async () => ({ channels: [] }),
	},
}));

const { BotsSection } = await import("../src/components/settings/BotsSection");
const { useChannelsStore } = await import("../src/store/channels");
const { useAgentsStore } = await import("../src/store/agents");

beforeEach(() => {
	apiCalls.length = 0;
	useChannelsStore.setState({ bots: [], conversations: [] });
	useAgentsStore.setState({
		list: [
			{ displayName: "前端开发者", model: "p/m" },
			{ displayName: "后端架构师", model: null },
		] as any,
	});
});
afterEach(() => cleanup());

test("空列表渲染 + 新建按钮打开渠道选择弹层", () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	expect(screen.getByTestId("new-bot-dialog")).toBeTruthy();
	// 企微可选，其余置灰
	expect(screen.getByTestId("channel-chip-wecom").getAttribute("data-disabled")).toBe("false");
	expect(screen.getByTestId("channel-chip-feishu").getAttribute("data-disabled")).toBe("true");
});

test("选择企微后填写表单并保存 → POST 正确载荷", async () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	fireEvent.click(screen.getByTestId("channel-chip-wecom"));
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "客服机器人" } });
	fireEvent.change(screen.getByTestId("bot-botid-input"), { target: { value: "ww123" } });
	fireEvent.change(screen.getByTestId("bot-secret-input"), { target: { value: "sec456" } });
	fireEvent.click(screen.getByTestId("bot-save-btn"));
	// handleSave 是异步的，等待 api 调用发生
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.length).toBe(1));
	expect(apiCalls[0].path).toBe("/api/channels");
	expect(apiCalls[0].body.channel).toMatchObject({
		type: "wecom",
		name: "客服机器人",
		credentials: { botId: "ww123", secret: "sec456" },
		replyGranularity: "standard",
		enabled: true,
	});
});

test("关联智能体已删除 → 显示降级警告条", () => {
	useChannelsStore.setState({
		bots: [
			{
				id: "ch_1", type: "wecom", name: "老机器人", enabled: false,
				credentials: { botId: "b", secret: "****" },
				agentName: "已被删除的智能体", model: null,
				extraSystemPrompt: "", replyGranularity: "simple", createdAt: 1,
				status: "disconnected",
			} as any,
		],
	});
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	expect(screen.getByTestId("bot-agent-missing-warning")).toBeTruthy();
});
