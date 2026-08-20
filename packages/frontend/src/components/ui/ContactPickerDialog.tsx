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
	onPick: (target: ImPushTarget) => void;
	onCancel: () => void;
}

/** 选择 IM 联系人弹窗：按渠道分组、单选（person/group 均可选）。
 *  数据来自 contacts/channels store，打开时主动拉取（store 初始为空）。 */
export function ContactPickerDialog({ onPick, onCancel }: Props) {
	const { t } = useTranslation();
	const contacts = useContactsStore((s) => s.contacts);
	const loadContacts = useContactsStore((s) => s.loadContacts);
	const bots = useChannelsStore((s) => s.bots);
	const loadBots = useChannelsStore((s) => s.loadBots);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	useEffect(() => {
		void loadContacts();
		void loadBots();
	}, [loadContacts, loadBots]);

	// 按渠道分组（保持 contacts 原始顺序；渠道名查 bots，未加载到时显示 id）
	const groups = useMemo(() => {
		const map = new Map<string, ContactEntity[]>();
		for (const c of contacts) {
			const list = map.get(c.channelId) ?? [];
			list.push(c);
			map.set(c.channelId, list);
		}
		return [...map.entries()].map(([channelId, list]) => ({
			channelId,
			channelName:
				bots.find((b) => b.id === channelId)?.name ?? channelId,
			list,
		}));
	}, [contacts, bots]);

	const selected = contacts.find((c) => c.id === selectedId);

	return (
		<Modal onClose={onCancel} data-testid="contact-picker-dialog">
			<div className="p-4 border-b border-hairline flex items-center justify-between">
				<div className="text-primary font-bold text-sm">
					{t("sendIm.dialogTitle")}
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
				{groups.length === 0 ? (
					<div
						className="text-secondary leading-relaxed"
						data-testid="contact-picker-empty"
					>
						{t("sendIm.empty")}
					</div>
				) : (
					groups.map((g) => (
						<div key={g.channelId} className="mb-3">
							<div className="text-tertiary text-xs mb-1">{g.channelName}</div>
							<div className="flex flex-col gap-1">
								{g.list.map((c) => (
									<button
										key={c.id}
										data-testid={`contact-picker-item-${c.id}`}
										onClick={() => setSelectedId(c.id)}
										className={`flex items-center gap-2 px-2 py-1.5 rounded-sm border text-left ${
											selectedId === c.id
												? "border-accent bg-accent-soft"
												: "border-hairline hover:bg-surface-hover"
										}`}
									>
										<Icon
											name={c.kind === "group" ? "users" : "user"}
											size={14}
										/>
										<span className="text-primary">{contactLabel(c)}</span>
									</button>
								))}
							</div>
						</div>
					))
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
					disabled={!selected}
					onClick={() =>
						selected &&
						onPick({
							channelId: selected.channelId,
							contactId: selected.id,
							label: contactLabel(selected),
							kind: selected.kind,
						})
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
