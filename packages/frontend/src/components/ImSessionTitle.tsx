import { useRef, useState } from "react";
import { contactOf, useContactsStore } from "../store/contacts";
import { Icon } from "./ui/Icon";
import type { ChannelConversationInfo } from "@wa-pi/shared";

interface Props {
	/** 默认技术标题（session.title，如「IM · u1」） */
	sessionTitle: string;
	/** 当前 IM 会话（用于定位通讯录联系人） */
	imConv: ChannelConversationInfo;
}

/**
 * IM 会话顶部标题：默认显示技术标题，编辑通讯录备注名后显示「IM · 备注名」。
 * 右侧铅笔图标进入行内编辑：Enter/失焦保存，Esc 取消；联系人不存在时自动补建后编辑。
 */
export default function ImSessionTitle({ sessionTitle, imConv }: Props) {
	const contacts = useContactsStore((s) => s.contacts);
	const kind = imConv.chatType === "group" ? "group" : "person";
	const key = kind === "group" ? imConv.chatId : imConv.fromUserId;
	const contact = contactOf(contacts, imConv.channelId, kind, key);

	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	// 防 Esc 取消后 onBlur 又触发保存；防 Enter 与 blur 重复保存
	const cancelled = useRef(false);
	const saving = useRef(false);

	const display = contact?.remark ? `IM · ${contact.remark}` : sessionTitle;

	const startEdit = () => {
		cancelled.current = false;
		setValue(contact?.remark ?? "");
		setEditing(true);
	};

	const save = async () => {
		if (cancelled.current || saving.current) return;
		saving.current = true;
		try {
			const remark = value.trim();
			let id = contact?.id;
			if (!id) {
				if (!remark) {
					setEditing(false);
					return;
				}
				const ensured = await useContactsStore
					.getState()
					.ensureContact(
						kind === "person"
							? { channelId: imConv.channelId, kind: "person", userId: key }
							: { channelId: imConv.channelId, kind: "group", chatId: key },
					);
				id = ensured?.id;
			}
			if (id) {
				await useContactsStore.getState().renameContact(id, remark);
			}
			setEditing(false);
		} finally {
			saving.current = false;
		}
	};

	const cancel = () => {
		cancelled.current = true;
		setEditing(false);
	};

	if (editing) {
		return (
			<input
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") void save();
					else if (e.key === "Escape") cancel();
				}}
				onBlur={() => void save()}
				data-testid="im-session-title-input"
				className="text-[calc(14px*var(--font-scale))] font-bold text-primary bg-surface border border-hairline rounded-sm px-1.5 py-0.5 outline-none min-w-0 w-48"
			/>
		);
	}

	return (
		<span className="flex items-center gap-1.5 min-w-0">
			<span className="text-[calc(14px*var(--font-scale))] font-bold text-primary truncate">
				{display}
			</span>
			<button
				type="button"
				onClick={startEdit}
				data-testid="im-session-title-edit"
				title="编辑通讯录名字"
				className="flex items-center justify-center cursor-pointer text-tertiary hover:text-primary shrink-0"
			>
				<Icon
					name="edit"
					size="1em"
					className="text-[calc(14px*var(--font-scale))]"
				/>
			</button>
		</span>
	);
}
