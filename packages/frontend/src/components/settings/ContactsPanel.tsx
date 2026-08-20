import { useEffect, useMemo, useState } from "react";
import { useContactsStore } from "../../store/contacts";
import { useToastStore } from "../../store/toast";
import type { ChannelType, ContactEntity } from "@wa-pi/shared";

/** 通讯录滑出面板：人/群两类 + 行内展开重命名 + 企微通讯录同步（wecom 渠道） */
export default function ContactsPanel({
	channelId,
	channelType,
	onClose,
}: {
	channelId: string;
	channelType?: ChannelType;
	onClose: () => void;
}) {
	const contacts = useContactsStore((s) => s.contacts);
	const { renameContact, loadContacts, syncWecomContacts } =
		useContactsStore.getState();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [value, setValue] = useState("");
	// 企微通讯录搜索：搜索框常驻（wecom 渠道），输入关键词点「搜索好友」→ 同步 → toast + 刷新
	const [syncKeyword, setSyncKeyword] = useState("");
	const [syncing, setSyncing] = useState(false);

	// 打开面板（或切换 channelId）时拉取通讯录，否则 store 初始为空、面板恒显示「暂无」
	useEffect(() => {
		void loadContacts();
	}, [channelId]);

	const isWecom = channelType === "wecom";

	const doSync = async () => {
		const keyword = syncKeyword.trim();
		if (!keyword) return;
		setSyncing(true);
		try {
			const { added } = await syncWecomContacts(channelId, [keyword]);
			// 只有新增了人才提示，无新增（已全部在通讯录）不打扰
			if (added > 0) {
				useToastStore.getState().add(`搜索完成：新增 ${added} 人`, "success");
			}
			setSyncKeyword("");
			void loadContacts(); // 同步后刷新列表
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setSyncing(false);
		}
	};

	const label = (c: ContactEntity): string =>
		c.remark ||
		(c.kind === "group" ? (c.chatId ?? "").slice(0, 8) : (c.userId ?? ""));

	const { persons, groups } = useMemo(() => {
		const mine = contacts.filter((c) => c.channelId === channelId);
		const q = syncKeyword.trim().toLowerCase();
		// 真搜索：关键词非空时按显示名过滤本地通讯录（人/群统一），同步搜索框同时承担过滤
		const filtered = q
			? mine.filter((c) => label(c).toLowerCase().includes(q))
			: mine;
		return {
			persons: filtered.filter((c) => c.kind === "person"),
			groups: filtered.filter((c) => c.kind === "group"),
		};
	}, [contacts, channelId, syncKeyword]);

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
			{isWecom && (
				<div className="flex gap-1 px-3 py-2 border-b border-hairline">
					<input
						value={syncKeyword}
						onChange={(e) => setSyncKeyword(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && !syncing && void doSync()}
						placeholder="输入姓名/部门关键词搜索"
						className="flex-1 min-w-0 px-2 py-1 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
						data-testid="contacts-sync-wecom-input"
					/>
					<button
						onClick={() => void doSync()}
						disabled={syncing}
						className="px-2 py-1 rounded-sm text-xs flex-shrink-0"
						style={{
							background: "var(--brand)",
							color: "var(--on-brand)",
						}}
						data-testid="contacts-sync-wecom-confirm"
					>
						{syncing ? "搜索中…" : "搜索好友"}
					</button>
				</div>
			)}
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
									className="flex-1 min-w-0 px-2 py-1 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none text-ellipsis"
								/>
								<button
									onClick={() => void save(c)}
									className="px-2 py-1 rounded-sm text-xs flex-shrink-0"
									style={{
										background: "var(--brand)",
										color: "var(--on-brand)",
									}}
								>
									保存
								</button>
								<button
									onClick={() => setEditingId(null)}
									className="px-2 py-1 rounded-sm text-xs border border-hairline flex-shrink-0"
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
								<span className="text-sm text-primary flex-1 min-w-0 truncate">
									{label(c)}
								</span>
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
									className="flex-1 min-w-0 px-2 py-1 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none text-ellipsis"
								/>
								<button
									onClick={() => void save(c)}
									className="px-2 py-1 rounded-sm text-xs flex-shrink-0"
									style={{
										background: "var(--brand)",
										color: "var(--on-brand)",
									}}
								>
									保存
								</button>
								<button
									onClick={() => setEditingId(null)}
									className="px-2 py-1 rounded-sm text-xs border border-hairline flex-shrink-0"
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
								<span className="text-sm text-primary flex-1 min-w-0 truncate">
									{label(c)}
								</span>
								<span className="text-xs text-tertiary flex-shrink-0">⋯</span>
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
