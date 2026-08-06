import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("../src/api-client", () => ({
	api: { get: async () => ({ conversations: [] }) },
}));

const { ImConversationList } = await import("../src/components/ImConversationList");
const { useChannelsStore } = await import("../src/store/channels");

afterEach(() => cleanup());

test("渲染会话项并点击回调 onSelectSession", () => {
	useChannelsStore.setState({
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
