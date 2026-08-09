import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	onClick: () => void;
	count?: number;
}

export function RecycleBinButton({ onClick, count }: Props) {
	const { t } = useTranslation();
	return (
		<button
			onClick={onClick}
			aria-label={t("trash.title")}
			title={t("trash.title")}
			className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand inline-flex items-center gap-1"
			data-testid="recycle-bin-btn"
		>
			<Icon
				name="trash"
				size="1em"
				className="text-[calc(16px*var(--font-scale))]"
			/>{" "}
			{t("trash.title")}
			{count != null && count > 0 && (
				<span
					className="ml-1 text-[10px] bg-danger text-white rounded-full px-1.5 leading-4"
					data-testid="recycle-bin-badge"
				>
					{count > 99 ? "99+" : count}
				</span>
			)}
		</button>
	);
}
