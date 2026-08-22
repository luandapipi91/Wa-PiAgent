import type { AttachmentDraft } from "@wa-pi/shared";
import { Icon, type IconName } from "./Icon";
import { useTranslation } from "../../i18n/useTranslation";

/** 附件 kind → 图标（统一 SVG 图标库，替代原 emoji） */
const ICON_BY_KIND: Record<AttachmentDraft["kind"], IconName> = {
	image: "image",
	audio: "mic",
	folder: "folder",
	snippet: "note",
	file: "file",
	element: "element",
};

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

	return (
		<span
			className={`inline-flex flex-col gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill${onClick ? " cursor-pointer hover:bg-surface-active" : ""}`}
			data-testid="attachment-chip"
			onClick={onClick}
		>
			<span className="inline-flex items-center gap-1">
				<Icon name={ICON_BY_KIND[attachment.kind]} size={12} />
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
