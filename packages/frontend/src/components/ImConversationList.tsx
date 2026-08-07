import { useEffect } from "react";
import { useChannelsStore } from "../store/channels";
import type { ChannelConversationInfo } from "@wa-pi/shared";

interface Props {
	onSelectSession: (id: string) => void;
}

/** 列表项标题：单聊显示 userid；群聊显示 群聊(chatId 前8位)（v1 拿不到用户昵称） */
function titleOf(c: ChannelConversationInfo): string {
	return c.chatType === "group" ? `群聊(${c.chatId.slice(0, 8)})` : c.chatId;
}

function timeOf(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}-${d.getDate()}`;
}

export function ImConversationList({ onSelectSession }: Props) {
	const conversations = useChannelsStore((s) => s.conversations);
	useEffect(() => {
		void useChannelsStore.getState().loadConversations();
	}, []);

	// 列表只展示最近 100 条会话记录（按 updatedAt 倒序）。注意：这是会话列表项数量上限，
	// 不是会话内消息历史的截断——会话内的完整消息历史照常加载。
	const recent = [...conversations]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 100);

	if (conversations.length === 0) {
		return <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-tertiary">暂无 IM 会话。在设置页配置机器人后，来自 IM 的对话会出现在这里。</div>;
	}
	return (
		<div className="flex-1 flex flex-col gap-1 overflow-auto" data-testid="im-conv-list">
			{recent.map((c) => (
				<button
					key={c.sessionId}
					onClick={() => onSelectSession(c.sessionId)}
					className="flex items-center gap-2 px-2 py-2 rounded-md text-left cursor-pointer border-0"
					style={{ background: "transparent" }}
					data-testid={`im-conv-${c.sessionId}`}
				>
					<img src={`/channels/${c.channelType}.ico`} alt="" className="w-6 h-6 rounded"
						onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-medium text-primary truncate">{titleOf(c)}</span>
						<span className="block text-xs text-tertiary truncate">
							{c.channelName} · {c.projectName} · {c.lastMessagePreview}
						</span>
					</span>
					<span className="text-xs text-tertiary flex-none">{timeOf(c.updatedAt)}</span>
				</button>
			))}
		</div>
	);
}
