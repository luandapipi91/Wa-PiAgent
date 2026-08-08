import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useChannelsStore } from "../store/channels";
import { useComposerPrefsStore } from "../store/composer-prefs";
import type { ChannelConversationInfo } from "@wa-pi/shared";
import { api } from "../api-client";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	onSelectSession: (id: string) => void;
}

function timeOf(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}-${d.getDate()}`;
}

// 右键菜单坐标 + 目标会话
interface MenuState {
	x: number;
	y: number;
	conv: ChannelConversationInfo;
}

export function ImConversationList({ onSelectSession }: Props) {
	const { t } = useTranslation();
	const conversations = useChannelsStore((s) => s.conversations);
	useEffect(() => {
		void useChannelsStore.getState().loadConversations();
	}, []);
	/** 列表项标题：单聊显示 userid；群聊显示 群聊(chatId 前8位) · 发送者（v1 拿不到用户昵称，用 userid 区分） */
	const titleOf = (c: ChannelConversationInfo) =>
		c.chatType === "group"
			? t("im.groupTitle", { chatId: c.chatId.slice(0, 8), from: c.fromUserId })
			: c.chatId;

	// 右键菜单 + 删除确认
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<ChannelConversationInfo | null>(null);

	// 列表只展示最近 100 条会话记录（按 updatedAt 倒序）。注意：这是会话列表项数量上限，
	// 不是会话内消息历史的截断——会话内的完整消息历史照常加载。
	const recent = [...conversations]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 100);

	// popup 关闭（点击任意处 / ESC）：延迟注册避免触发当前右键的 click
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		const id = setTimeout(() => {
			document.addEventListener("click", close);
			document.addEventListener("keydown", onKey);
		}, 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("click", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const handleDeleteClick = () => {
		if (!menu) return;
		setDeleteTarget(menu.conv);
		setMenu(null);
	};

	const handleDeleteConfirm = () => {
		if (!deleteTarget) return;
		const sid = deleteTarget.sessionId;
		void api.del(`/api/sessions/${encodeURIComponent(sid)}`);
		// 同步清理该会话的 composer 草稿（与任务侧删除一致）
		useComposerPrefsStore.getState().removeSessionPrefs(sid);
		setDeleteTarget(null);
	};

	if (conversations.length === 0) {
		return <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-tertiary">{t("im.emptyHint")}</div>;
	}
	return (
		<div className="flex-1 flex flex-col gap-1 overflow-auto" data-testid="im-conv-list">
			{recent.map((c) => (
				<ImConvRow
					key={c.sessionId}
					conv={c}
					titleOf={titleOf}
					onSelect={onSelectSession}
					onContextMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, conv: c })}
				/>
			))}

			{/* 右键菜单 */}
			{menu &&
				createPortal(
					<div
						className="fixed z-50 rounded-md py-1 text-sm border border-hairline"
						style={{
							left: menu.x,
							top: menu.y,
							background: "var(--surface)",
							boxShadow: "var(--shadow-lg)",
							minWidth: 140,
						}}
						onClick={(e) => e.stopPropagation()}
						data-testid="im-conv-context-menu"
					>
						<button
							onClick={handleDeleteClick}
							className="w-full text-left px-3 py-1.5 text-danger transition-colors hover:bg-danger-soft"
							data-testid="im-menu-delete"
						>
							{t("im.deleteChat")}
						</button>
					</div>,
					document.body,
				)}

			{/* 删除确认框 */}
			{deleteTarget && (
				<ConfirmDialog
					title={t("im.deleteChat")}
					message={t("im.deleteConfirmMessage", { title: titleOf(deleteTarget) })}
					confirmText={t("common.delete")}
					danger
					onConfirm={handleDeleteConfirm}
					onCancel={() => setDeleteTarget(null)}
				/>
			)}
		</div>
	);
}

/** 单个 IM 会话项：原生 contextmenu 监听确保 preventDefault 生效（与 SessionRow 一致） */
function ImConvRow({
	conv,
	titleOf,
	onSelect,
	onContextMenu,
}: {
	conv: ChannelConversationInfo;
	titleOf: (c: ChannelConversationInfo) => string;
	onSelect: (id: string) => void;
	onContextMenu: (e: MouseEvent) => void;
}) {
	const btnRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const el = btnRef.current;
		if (!el) return;
		const handler = (e: Event) => {
			e.preventDefault();
			onContextMenu(e as unknown as MouseEvent);
		};
		el.addEventListener("contextmenu", handler);
		return () => el.removeEventListener("contextmenu", handler);
	}, [onContextMenu]);

	return (
		<button
			ref={btnRef}
			onClick={() => onSelect(conv.sessionId)}
			className="flex items-center gap-2 px-2 py-2 rounded-md text-left cursor-pointer border-0"
			style={{ background: "transparent" }}
			data-testid={`im-conv-${conv.sessionId}`}
		>
			<img src={`/channels/${conv.channelType}.ico`} alt="" className="w-6 h-6 rounded"
				onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium text-primary truncate">{titleOf(conv)}</span>
				<span className="block text-xs text-tertiary truncate">
					{conv.channelName} · {conv.projectName} · {conv.lastMessagePreview}
				</span>
			</span>
			<span className="text-xs text-tertiary flex-none">{timeOf(conv.updatedAt)}</span>
		</button>
	);
}
