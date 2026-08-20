import { useEffect, useMemo, useState } from "react";
import { useContactsStore } from "../../store/contacts";
import { useToastStore } from "../../store/toast";
import type { ContactEntity } from "@wa-pi/shared";

/** 通讯录滑出面板：人/群两类 + 行内展开重命名 */
export default function ContactsPanel({
	channelId,
	onClose,
}: {
	channelId: string;
	onClose: () => void;
}) {
	const contacts = useContactsStore((s) => s.contacts);
	const { renameContact, loadContacts } = useContactsStore.getState();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [value, setValue] = useState("");

	// 打开面板（或切换 channelId）时拉取通讯录，否则 store 初始为空、面板恒显示「暂无」
	useEffect(() => {
		void loadContacts();
	}, [channelId]);

	const { persons, groups } = useMemo(() => {
		const mine = contacts.filter((c) => c.channelId === channelId);
		return {
			persons: mine.filter((c) => c.kind === "person"),
			groups: mine.filter((c) => c.kind === "group"),
		};
	}, [contacts, channelId]);

	const label = (c: ContactEntity): string =>
		c.remark ||
		(c.kind === "group" ? (c.chatId ?? "").slice(0, 8) : (c.userId ?? ""));

	const save = async (c: ContactEntity) => {
		try {
			await renameContact(c.id, value.trim());
			setEditingId(null);
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
		}
	};

	return (
		<div
			className="absolute inset-y-0 right-0 z-40 w-64 border-l border-hairline flex flex-col"
			style={{ background: "var(--surface)", boxShadow: "var(--shadow-lg)" }}
			data-testid="contacts-panel"
		>
			<div className="flex items-center justify-between px-3 py-2 border-b border-hairline">
				<span className="text-sm text-primary">通讯录</span>
				<button
					onClick={onClose}
					className="text-tertiary cursor-pointer"
					data-testid="contacts-close"
				>
					✕
				</button>
			</div>
			<div className="flex-1 overflow-auto p-3 flex flex-col gap-1">
				{persons.length === 0 && groups.length === 0 && (
					<div className="text-xs text-tertiary text-center py-4">
						暂无对话过的人/群
					</div>
				)}
				{persons.length > 0 && (
					<div className="text-xs text-secondary font-medium">人</div>
				)}
				{persons.map((c) => (
					<div key={c.id} className="border border-hairline rounded-sm">
						{editingId === c.id ? (
							<div className="flex gap-1 px-2 py-1.5">
								<input
									autoFocus
									value={value}
									onChange={(e) => setValue(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && void save(c)}
									className="flex-1 min-w-0 px-2 py-1 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								/>
								<button
									onClick={() => void save(c)}
									className="px-2 py-1 rounded-sm text-xs"
									style={{
										background: "var(--brand)",
										color: "var(--on-brand)",
									}}
								>
									保存
								</button>
								<button
									onClick={() => setEditingId(null)}
									className="px-2 py-1 rounded-sm text-xs border border-hairline"
								>
									取消
								</button>
							</div>
						) : (
							<div
								className="flex items-center justify-between px-2 py-1.5 cursor-pointer"
								onClick={() => {
									setEditingId(c.id);
									setValue(c.remark ?? label(c));
								}}
							>
								<span className="text-sm text-primary flex-1 min-w-0 truncate">{label(c)}</span>
								<span className="text-xs text-tertiary flex-shrink-0">⋯</span>
							</div>
						)}
					</div>
				))}
				{groups.length > 0 && (
					<div className="text-xs text-secondary font-medium mt-2">群</div>
				)}
				{groups.map((c) => (
					<div key={c.id} className="border border-hairline rounded-sm">
						{editingId === c.id ? (
							<div className="flex gap-1 px-2 py-1.5">
								<input
									autoFocus
									value={value}
									onChange={(e) => setValue(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && void save(c)}
									className="flex-1 min-w-0 px-2 py-1 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								/>
								<button
									onClick={() => void save(c)}
									className="px-2 py-1 rounded-sm text-xs"
									style={{
										background: "var(--brand)",
										color: "var(--on-brand)",
									}}
								>
									保存
								</button>
								<button
									onClick={() => setEditingId(null)}
									className="px-2 py-1 rounded-sm text-xs border border-hairline"
								>
									取消
								</button>
							</div>
						) : (
							<div
								className="flex items-center justify-between px-2 py-1.5 cursor-pointer"
								onClick={() => {
									setEditingId(c.id);
									setValue(c.remark ?? label(c));
								}}
							>
								<span className="text-sm text-primary flex-1 min-w-0 truncate">{label(c)}</span>
								<span className="text-xs text-tertiary flex-shrink-0">⋯</span>
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
