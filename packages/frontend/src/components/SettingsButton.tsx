import { Icon } from "./ui/Icon";

interface Props {
	onClick: () => void;
}

export function SettingsButton({ onClick }: Props) {
	return (
		<button
			onClick={onClick}
			className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand inline-flex items-center gap-1"
			data-testid="settings-btn"
		>
			<Icon
				name="settings"
				size="1em"
				className="text-[calc(18px*var(--font-scale))]"
			/>{" "}
			系统设置
		</button>
	);
}
