import type { AttachmentDraft } from "@wa-pi/shared";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { useTranslation } from "../../i18n/useTranslation";

/** 附件 kind → 图标（统一 SVG 图标库，替代原 emoji） */
const ICON_BY_KIND: Record<AttachmentDraft["kind"], IconName> = {
	image: "image",
	audio: "mic",
	folder: "folder",
	snippet: "note",
	file: "file",
};

interface Props {
	attachment: AttachmentDraft;
	onRemove: () => void;
	onClick?: () => void;
	/** 图片在附件列表中的序号（1-based，仅图片计数）→ 显示 i18n「图片N」；缺省回退文件名 */
	imageOrdinal?: number;
	/** 图片缩略图地址（kernel /file URL）；缺省或加载失败回退图标 */
	thumbnailSrc?: string;
}

export function AttachmentChip({
	attachment,
	onRemove,
	onClick,
	imageOrdinal,
	thumbnailSrc,
}: Props) {
	const { t } = useTranslation();
	const [thumbFailed, setThumbFailed] = useState(false);

	// 删除前一张会使后一张顶上同一 index（组件实例复用），换图源时清掉旧的失败态
	useEffect(() => setThumbFailed(false), [thumbnailSrc]);

	const label =
		attachment.kind === "snippet"
			? attachment.content.slice(0, 20) +
				(attachment.content.length > 20 ? "…" : "")
			: attachment.kind === "image" && imageOrdinal != null
				? t("ui.attachmentChip.imageName", { n: imageOrdinal })
				: attachment.name;

	const removeButton = (className: string) => (
		<button
			type="button"
			aria-label={t("ui.attachmentChip.removeAriaLabel")}
			data-testid="attachment-remove"
			onClick={(e) => {
				e.stopPropagation();
				onRemove();
			}}
			className={className}
		>
			✕
		</button>
	);

	// 图片：缩略图卡片（56×56）+ i18n 编号，替代原「图标 + 文件名胶囊」
	if (attachment.kind === "image" && imageOrdinal != null) {
		return (
			<span
				className={`relative inline-flex flex-col items-center gap-1${onClick ? " cursor-pointer" : ""}`}
				data-testid="attachment-chip"
				title={attachment.name}
				onClick={onClick}
			>
				<span className="relative block h-14 w-14">
					{thumbnailSrc && !thumbFailed ? (
						<img
							src={thumbnailSrc}
							alt={label}
							data-testid="attachment-thumb"
							draggable={false}
							onError={() => setThumbFailed(true)}
							className="h-14 w-14 rounded-lg border border-hairline bg-surface-hover object-cover"
						/>
					) : (
						<span className="flex h-14 w-14 items-center justify-center rounded-lg border border-hairline bg-surface-hover text-tertiary">
							<Icon name="image" size={18} />
						</span>
					)}
					{removeButton(
						"absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border-0 bg-black/60 text-[10px] leading-none text-white cursor-pointer hover:bg-danger",
					)}
				</span>
				<span className="text-xs text-secondary truncate max-w-[72px]">
					{label}
				</span>
			</span>
		);
	}

	return (
		<span
			className={`inline-flex flex-col gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill${onClick ? " cursor-pointer hover:bg-surface-active" : ""}`}
			data-testid="attachment-chip"
			onClick={onClick}
		>
			<span className="inline-flex items-center gap-1">
				<Icon name={ICON_BY_KIND[attachment.kind]} size={12} />
				<span className="truncate max-w-[150px]">{label}</span>
				{removeButton("text-tertiary hover:text-danger ml-1")}
			</span>
		</span>
	);
}
