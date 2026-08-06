import { Modal } from "../ui/Modal";
import type { ChannelType } from "@wa-pi/shared";

interface Props {
	onSelect: (type: ChannelType) => void;
	onClose: () => void;
}

const CHANNELS: { type: ChannelType; name: string; icon: string; enabled: boolean; hint: string }[] = [
	{ type: "wecom", name: "企业微信", icon: "/channels/wecom.ico", enabled: true, hint: "Bot ID + Secret · 长连接" },
	{ type: "wechat", name: "微信", icon: "/channels/wechat.svg", enabled: false, hint: "" },
	{ type: "feishu", name: "飞书", icon: "/channels/feishu.ico", enabled: false, hint: "" },
	{ type: "qq", name: "QQ", icon: "/channels/qq.svg", enabled: false, hint: "" },
];

export function NewBotDialog({ onSelect, onClose }: Props) {
	return (
		<Modal onClose={onClose} width={420} data-testid="new-bot-dialog">
			<div className="p-4 border-b border-hairline">
				<span className="text-primary font-bold text-sm">选择渠道类型</span>
			</div>
			<div className="p-3 flex flex-col gap-2">
				{CHANNELS.map((c) => (
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
							alt={c.name}
							className="w-5 h-5 rounded"
							style={c.enabled ? undefined : { filter: "grayscale(1)", opacity: 0.45 }}
						/>
						<span className="text-sm">{c.name}</span>
						{c.hint && <span className="text-xs text-tertiary">{c.hint}</span>}
						{!c.enabled && (
							<span className="ml-auto text-xs text-tertiary border border-hairline rounded-pill px-2 py-0.5">敬请期待</span>
						)}
					</button>
				))}
			</div>
		</Modal>
	);
}
