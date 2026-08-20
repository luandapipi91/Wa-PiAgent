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
 *  数据来自 contacts store，打开时主动拉取（store 初始为空）。 */
/** 搜索输入防抖（ms）：停止输入后触发企微异步同步 */
const SEARCH_DEBOUNCE_MS = 400;

export function ContactPickerDialog({ onPick, onCancel }: Props) {
	const { t } = useTranslation();
	const contacts = useContactsStore((s) => s.contacts);
	const loadContacts = useContactsStore((s) => s.loadContacts);
	const syncWecomContacts = useContactsStore((s) => s.syncWecomContacts);
	const bots = useChannelsStore((s) => s.bots);
	const [query, setQuery] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		void loadContacts();
	}, [loadContacts]);

	// 企微异步搜索同步：输入关键词（防抖）时，若有 wecom 渠道（有权限）就同步企微成员
	// 到本地通讯录并刷新；无 wecom 渠道（没权限）静默不做，不提示。同步失败也静默忽略。
	const wecomChannels = useMemo(
		() => bots.filter((b) => b.type === "wecom"),
		[bots],
	);
	useEffect(() => {
		const keyword = query.trim();
		if (!keyword || wecomChannels.length === 0) return;
		const timer = setTimeout(() => {
			// 逐个同步 wecom 渠道；全部失败也不 toast（无权限/过期均静默）
			void Promise.allSettled(
				wecomChannels.map((b) => syncWecomContacts(b.id, [keyword])),
			).then(() => void loadContacts());
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, wecomChannels, syncWecomContacts, loadContacts]);

	// 按名字搜索过滤（contactLabel 即显示名：remark 优先 / group chatId 前 8 位 / userId / id）
	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return contacts;
		return contacts.filter((c) => contactLabel(c).toLowerCase().includes(q));
	}, [contacts, query]);

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
						<div className="mb-3">
							<input
								data-testid="contact-picker-search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("sendIm.searchPlaceholder")}
								className="w-full px-2.5 py-1.5 rounded-md border border-hairline bg-surface text-primary text-sm outline-none focus:border-accent"
							/>
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
