import { useEffect, useMemo, useState } from "react";
import type { ContactEntity } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { useContactsStore, contactLabel } from "../../store/contacts";
import { useChannelsStore } from "../../store/channels";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

/** 「发送给 IM 联系人」选中的目标（ComposerInput 据此构造 @im-push-to token） */
export interface ImPushTarget {
	channelId: string;
	contactId: string;
	label: string;
	kind: "person" | "group";
}

interface Props {
	/** 多选确认：按通讯录顺序返回全部选中目标（ComposerInput 逐个生成 chip token） */
	onPick: (targets: ImPushTarget[]) => void;
	onCancel: () => void;
}

/** 选择 IM 联系人弹窗：统一通讯录列表（标题显示总数）、按名字搜索、多选（person/group 均可选）。
 *  数据来自 contacts store，打开时主动拉取（store 初始为空）。
 *  输入仅更新草稿，点「搜索好友」才应用本地过滤；有 wecom 渠道时顺带同步企微成员到本地并刷新，无权限则仅本地过滤（静默）。 */
export function ContactPickerDialog({ onPick, onCancel }: Props) {
	const { t } = useTranslation();
	const contacts = useContactsStore((s) => s.contacts);
	const loadContacts = useContactsStore((s) => s.loadContacts);
	const syncWecomContacts = useContactsStore((s) => s.syncWecomContacts);
	const bots = useChannelsStore((s) => s.bots);
	const [query, setQuery] = useState("");
	// 已应用的关键词：点「搜索好友」才更新，驱动本地过滤
	const [appliedQuery, setAppliedQuery] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		void loadContacts();
	}, [loadContacts]);

	// 有 wecom 渠道（有权限）才同步企微；同步失败静默忽略（无 toast）
	const wecomChannels = useMemo(
		() => bots.filter((b) => b.type === "wecom"),
		[bots],
	);
	const [searching, setSearching] = useState(false);

	const doSearch = async () => {
		const keyword = query.trim();
		if (!keyword) return;
		// 先应用本地过滤（无论有无权限）
		setAppliedQuery(keyword);
		if (wecomChannels.length === 0) return;
		setSearching(true);
		try {
			// 逐个同步 wecom 渠道；全部失败也不 toast（无权限/过期均静默）
			await Promise.allSettled(
				wecomChannels.map((b) => syncWecomContacts(b.id, [keyword])),
			);
			await loadContacts();
		} finally {
			setSearching(false);
		}
	};

	// 按「已应用关键词」过滤（contactLabel 即显示名：remark 优先 / group chatId 前 8 位 / userId / id）
	const visible = useMemo(() => {
		const q = appliedQuery.toLowerCase();
		if (!q) return contacts;
		return contacts.filter((c) => contactLabel(c).toLowerCase().includes(q));
	}, [contacts, appliedQuery]);

	// 多选切换；确认返回按通讯录原始顺序排列的选中项
	const toggle = (c: ContactEntity) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(c.id)) next.delete(c.id);
			else next.add(c.id);
			return next;
		});
	};

	const selected = contacts.filter((c) => selectedIds.has(c.id));

	return (
		<Modal onClose={onCancel} data-testid="contact-picker-dialog">
			<div className="p-4 border-b border-hairline flex items-center justify-between">
				<div className="text-primary font-bold text-sm">
					{t("sendIm.dialogTitle", { count: contacts.length })}
				</div>
				<button
					onClick={onCancel}
					className="text-tertiary text-xs"
					data-testid="contact-picker-close"
					aria-label={t("common.close")}
				>
					✕
				</button>
			</div>
			<div className="p-4 text-sm max-h-80 overflow-y-auto">
				{contacts.length === 0 ? (
					<div
						className="text-secondary leading-relaxed"
						data-testid="contact-picker-empty"
					>
						{t("sendIm.empty")}
					</div>
				) : (
					<>
						<div className="mb-3 flex gap-2">
							<input
								data-testid="contact-picker-search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) =>
									e.key === "Enter" && !searching && void doSearch()
							}
								placeholder={t("sendIm.searchPlaceholder")}
								className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-hairline bg-surface text-primary text-sm outline-none focus:border-accent"
							/>
							<button
								data-testid="contact-picker-search-btn"
								onClick={() => void doSearch()}
								disabled={searching}
								className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
								style={{
									background: "var(--brand)",
									color: "var(--on-brand)",
								}}
							>
								{searching ? "搜索中…" : "搜索好友"}
							</button>
						</div>
						{visible.length === 0 ? (
							<div
								className="text-secondary leading-relaxed"
								data-testid="contact-picker-empty"
							>
								{t("sendIm.noMatch")}
							</div>
						) : (
							<div className="flex flex-col gap-1">
								{visible.map((c) => (
									<button
										key={c.id}
										data-testid={`contact-picker-item-${c.id}`}
										onClick={() => toggle(c)}
										className={`flex items-center gap-2 px-2 py-1.5 rounded-sm border text-left ${
											selectedIds.has(c.id)
												? "border-accent bg-accent-soft"
												: "border-hairline hover:bg-surface-hover"
										}`}
									>
										<Icon name={c.kind === "group" ? "users" : "user"} size={14} />
										<span className="text-primary min-w-0 truncate">
											{contactLabel(c)}
										</span>
									</button>
								))}
							</div>
						)}
					</>
				)}
			</div>
			<div className="flex justify-end gap-2 p-3 border-t border-hairline">
				<button
					data-testid="contact-picker-cancel"
					onClick={onCancel}
					className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline"
				>
					{t("common.cancel")}
				</button>
				<button
					data-testid="contact-picker-ok"
					disabled={selected.length === 0}
					onClick={() =>
						selected.length > 0 &&
						onPick(
							selected.map((c) => ({
								channelId: c.channelId,
								contactId: c.id,
								label: contactLabel(c),
								kind: c.kind,
							})),
						)
					}
					className="px-3 py-1.5 rounded-sm text-sm disabled:opacity-50"
					style={{ background: "var(--brand)", color: "var(--on-brand)" }}
				>
					{t("common.confirm")}
				</button>
			</div>
		</Modal>
	);
}
