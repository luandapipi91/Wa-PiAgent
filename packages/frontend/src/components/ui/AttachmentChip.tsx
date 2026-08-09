import type { AttachmentDraft } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	attachment: AttachmentDraft;
	onRemove: () => void;
	onClick?: () => void;
}

export function AttachmentChip({ attachment, onRemove, onClick }: Props) {
	const { t } = useTranslation();
	const label =
		attachment.kind === "snippet"
			? attachment.content.slice(0, 20) +
				(attachment.content.length > 20 ? "…" : "")
			: attachment.name;
	const icon =
		attachment.kind === "image"
			? "📷"
			: attachment.kind === "audio"
				? "🎤"
				: attachment.kind === "folder"
					? "📁"
					: attachment.kind === "snippet"
						? "📝"
						: "📄";

	return (
		<span
			className={`inline-flex flex-col gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill${onClick ? " cursor-pointer hover:bg-surface-active" : ""}`}
			data-testid="attachment-chip"
			onClick={onClick}
		>
			<span className="inline-flex items-center gap-1">
				<span>{icon}</span>
				<span className="truncate max-w-[150px]">{label}</span>
				<button
					type="button"
					aria-label={t("ui.attachmentChip.removeAriaLabel")}
					data-testid="attachment-remove"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					className="text-tertiary hover:text-danger ml-1"
				>
					✕
				</button>
			</span>
		</span>
	);
}
