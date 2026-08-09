import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";
import type { ChannelType } from "@wa-pi/shared";

interface Props {
	onSelect: (type: ChannelType) => void;
	onClose: () => void;
}

/** 渠道项：nameKey/hintKey 为 i18n key，hintKey 为空字符串表示无 hint */
const CHANNELS: { type: ChannelType; nameKey: string; icon: string; enabled: boolean; hintKey: string }[] = [
	{ type: "wecom", nameKey: "settings.bot.channelWecom", icon: "/channels/wecom.ico", enabled: true, hintKey: "settings.bot.channelWecomHint" },
	{ type: "wechat", nameKey: "settings.bot.channelWechat", icon: "/channels/wechat.svg", enabled: false, hintKey: "" },
	{ type: "feishu", nameKey: "settings.bot.channelFeishu", icon: "/channels/feishu.ico", enabled: false, hintKey: "" },
	{ type: "qq", nameKey: "settings.bot.channelQq", icon: "/channels/qq.svg", enabled: false, hintKey: "" },
];

export function NewBotDialog({ onSelect, onClose }: Props) {
	const { t } = useTranslation();
	return (
		<Modal onClose={onClose} width={420} data-testid="new-bot-dialog">
			<div className="p-4 border-b border-hairline">
				<span className="text-primary font-bold text-sm">{t("settings.bot.selectChannelType")}</span>
			</div>
			<div className="p-3 flex flex-col gap-2">
				{CHANNELS.map((c) => {
					const name = t(c.nameKey);
					return (
						<button
							key={c.type}
							disabled={!c.enabled}
							onClick={() => c.enabled && onSelect(c.type)}
							className="flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-hairline text-left transition-colors"
							style={c.enabled
								? { background: "var(--surface)", cursor: "pointer" }
								: { background: "var(--surface-elevated)", color: "var(--text-tertiary)", cursor: "not-allowed" }}
							data-testid={`channel-chip-${c.type}`}
							data-disabled={String(!c.enabled)}
						>
							<img
								src={c.icon}
								alt={name}
								className="w-5 h-5 rounded"
								style={c.enabled ? undefined : { filter: "grayscale(1)", opacity: 0.45 }}
							/>
							<span className="text-sm">{name}</span>
							{c.hintKey && <span className="text-xs text-tertiary">{t(c.hintKey)}</span>}
							{!c.enabled && (
								<span className="ml-auto text-xs text-tertiary border border-hairline rounded-pill px-2 py-0.5">{t("settings.bot.comingSoon")}</span>
							)}
						</button>
					);
				})}
			</div>
		</Modal>
	);
}
