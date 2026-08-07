import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// api mock：按 path 分发（与 channels-store.test.tsx 同款，避免 mock.module 互相覆盖时
// 缺方法导致同批跑的测试失败）；del 用 spy 断言删除调用
const delMock = mock();
mock.module("../src/api-client", () => ({
	api: {
		get: async (path: string) => {
			if (path === "/api/channel-conversations") return { conversations: [] };
			if (path === "/api/channels") return { channels: [] };
			return {};
		},
		del: delMock,
	},
}));
// composer-prefs 的 removeSessionSession 在删除时被调用，mock 掉避免触碰 IndexedDB
mock.module("../src/store/composer-prefs", () => ({
	useComposerPrefsStore: { getState: () => ({ removeSessionPrefs: () => {} }) },
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

test("右键会话弹菜单，点删除聊天弹确认框，确认后调 DELETE /api/sessions/:id", async () => {
	useChannelsStore.setState({
		conversations: [
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "zhangsan", chatType: "single",
				sessionId: "sess_del", projectId: "__system__", projectName: "默认工作区",
				lastMessagePreview: "好的", updatedAt: Date.now(),
			},
		] as any,
	});
	delMock.mockClear();
	render(<ImConversationList onSelectSession={() => {}} />);
	// 右键会话项 → 弹出菜单（contextmenu 事件触发原生监听）
	fireEvent.contextMenu(screen.getByTestId("im-conv-sess_del"));
	expect(screen.getByTestId("im-conv-context-menu")).toBeTruthy();
	expect(screen.getByTestId("im-menu-delete")).toBeTruthy();
	// 点「删除聊天」→ 弹确认框
	fireEvent.click(screen.getByTestId("im-menu-delete"));
	expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
	// 确认 → 调 DELETE 接口
	fireEvent.click(screen.getByTestId("confirm-ok"));
	expect(delMock).toHaveBeenCalledTimes(1);
	expect(delMock.mock.calls[0][0]).toContain("/api/sessions/sess_del");
});

test("确认删除后确认框关闭", async () => {
	useChannelsStore.setState({
		conversations: [
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "zhangsan", chatType: "single",
				sessionId: "sess_del2", projectId: "__system__", projectName: "默认工作区",
				lastMessagePreview: "", updatedAt: Date.now(),
			},
		] as any,
	});
	delMock.mockClear();
	render(<ImConversationList onSelectSession={() => {}} />);
	fireEvent.contextMenu(screen.getByTestId("im-conv-sess_del2"));
	fireEvent.click(screen.getByTestId("im-menu-delete"));
	fireEvent.click(screen.getByTestId("confirm-ok"));
	// 确认后对话框消失
	await waitFor(() => {
		expect(screen.queryByTestId("confirm-dialog")).toBeNull();
	});
});
