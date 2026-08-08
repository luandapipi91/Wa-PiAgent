import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	onClick: () => void;
}

export function SettingsButton({ onClick }: Props) {
	const { t } = useTranslation();
	return (
		<button
			onClick={onClick}
			aria-label={t("settings.title")}
			title={t("settings.title")}
			className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand inline-flex items-center gap-1"
			data-testid="settings-btn"
		>
			<Icon
				name="settings"
				size="1em"
				className="text-[calc(18px*var(--font-scale))]"
			/>{" "}
			{t("settings.title")}
		</button>
	);
}
