import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("../src/api-client", () => ({
	api: { get: async () => ({ conversations: [] }) },
}));

const { ImConversationList } = await import("../src/components/ImConversationList");
const { useChannelsStore } = await import("../src/store/channels");

afterEach(() => cleanup());

test("有会话时列表根容器带 flex-1（吃掉剩余高度，让侧边栏底部的系统设置按钮固定）", () => {
	useChannelsStore.setState({
		conversations: [
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "zhangsan", chatType: "single",
				sessionId: "sess_1", projectId: "__system__", projectName: "默认工作区",
				lastMessagePreview: "好的", updatedAt: Date.now(),
			},
		] as any,
	});
	render(<ImConversationList onSelectSession={() => {}} />);
	// 根容器需带 flex-1 才能把系统设置按钮钉在侧边栏底部（与任务 tab 的 ProjectList 对齐）
	expect(screen.getByTestId("im-conv-list").className).toContain("flex-1");
});

test("空态根容器带 flex-1（避免空内容时按钮上浮，与任务 tab 行为一致）", () => {
	useChannelsStore.setState({ conversations: [] });
	render(<ImConversationList onSelectSession={() => {}} />);
	// 空态文案直接挂在根 div 上，getByText 返回的就是根容器
	expect(screen.getByText(/暂无 IM 会话/).className).toContain("flex-1");
});

test("渲染会话项并点击回调 onSelectSession", () => {	useChannelsStore.setState({
		conversations: [
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "zhangsan", chatType: "single",
				sessionId: "sess_1", projectId: "__system__", projectName: "默认工作区",
				lastMessagePreview: "好的", updatedAt: Date.now(),
			},
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "wr_abcdef123", chatType: "group",
				sessionId: "sess_2", projectId: "p1", projectName: "hiagent",
				lastMessagePreview: "收到", updatedAt: Date.now() - 86_400_000,
			},
		] as any,
	});
	const onSelect = mock();
	render(<ImConversationList onSelectSession={onSelect} />);
	// 单聊显示 userid；群聊显示 群聊(前8位)
	expect(screen.getByText("zhangsan")).toBeTruthy();
	expect(screen.getByText("群聊(wr_abcde)")).toBeTruthy();
	expect(screen.getByText(/hiagent/)).toBeTruthy();
	fireEvent.click(screen.getByTestId("im-conv-sess_1"));
	expect(onSelect).toHaveBeenCalledWith("sess_1");
});

test("会话列表超过 100 条只显示最近 100 条（按 updatedAt 倒序）", () => {
	// 造 105 条会话，updatedAt 递增；期望只渲染最近 100 条（即 sessionId 5..104）
	const convs = Array.from({ length: 105 }, (_, i) => ({
		channelId: "ch_1", channelName: "机器人", channelType: "wecom",
		chatId: `u${i}`, chatType: "single",
		sessionId: `sess_${i}`, projectId: "__system__", projectName: "默认工作区",
		lastMessagePreview: "hi", updatedAt: 1000 + i,
	} as any));
	useChannelsStore.setState({ conversations: convs });
	render(<ImConversationList onSelectSession={() => {}} />);
	const items = screen.getAllByTestId(/^im-conv-sess_/);
	// 只显示 100 条
	expect(items).toHaveLength(100);
	// 最近的最在前（updatedAt 倒序）：首项应为 sess_104，末项为 sess_5
	expect(items[0].getAttribute("data-testid")).toBe("im-conv-sess_104");
	expect(items[99].getAttribute("data-testid")).toBe("im-conv-sess_5");
});
