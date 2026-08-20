import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	onClick: () => void;
	count?: number;
	/** 窄侧栏模式：隐藏文字只保留图标 */
	compact?: boolean;
}

export function RecycleBinButton({ onClick, count, compact }: Props) {
	const { t } = useTranslation();
	return (
		<button
			onClick={onClick}
			aria-label={t("trash.title")}
			title={t("trash.title")}
			className={`flex-1 min-w-0 flex items-center gap-1 px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand overflow-hidden ${
				compact ? "justify-center" : ""
			}`}
			data-testid="recycle-bin-btn"
		>
			<Icon
				name="trash"
				size="1em"
				className="text-[calc(16px*var(--font-scale))] flex-shrink-0"
			/>
			{!compact && (
				<span className="whitespace-nowrap truncate shrink">
					{t("trash.title")}
				</span>
			)}
			{count != null && count > 0 && (
				<span
					className="ml-1 text-[10px] bg-danger text-white rounded-full px-1.5 leading-4 flex-shrink-0"
					data-testid="recycle-bin-badge"
				>
					{count > 99 ? "99+" : count}
				</span>
			)}
		</button>
	);
}
