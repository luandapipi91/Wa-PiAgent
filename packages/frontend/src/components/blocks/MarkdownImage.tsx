import { useState } from "react";
import { useSessionStore } from "../../store/session";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { FilePill } from "./FilePill";
import { MarkdownLink } from "./markdown-components";
import { fileNameOf, resolveMediaSrc, type MediaItem } from "./media-utils";

// ⚠️ 循环依赖：markdown-components → MarkdownImage → markdown-components(MarkdownLink)，
// 与既有 FilePill 循环同一性质——顶层不得求值对方模块级值，仅渲染期 JSX 引用。

/** markdown 图片卡片：限高缩略图 + 底部文件名/尺寸行；hover 边框高亮 + 右下角放大按钮；
 *  点击打开 MediaPreviewModal 画廊；加载失败降级 FilePill（本地）/普通链接（远程）。 */
export function MarkdownImage({
	src,
	alt,
	sessionId,
	items,
}: {
	src?: string;
	alt?: string;
	sessionId: string;
	items: MediaItem[];
}) {
	const [failed, setFailed] = useState(false);
	const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
	const { t } = useTranslation();
	if (!src) return null;
	const isRemote = /^(https?:|data:|blob:)/i.test(src);
	if (failed) {
		return isRemote ? (
			<MarkdownLink href={src}>{alt || src}</MarkdownLink>
		) : (
			<FilePill rawText={src} sessionId={sessionId} />
		);
	}
	const name = fileNameOf(src);
	const open = () => {
		const idx = items.findIndex((it) => it.src === src && it.kind === "image");
		const list =
			idx >= 0
				? items
				: [{ src, kind: "image" as const, name: alt?.trim() || name }];
		useSessionStore
			.getState()
			.openMediaPreview(list, idx >= 0 ? idx : 0, sessionId);
	};
	return (
		<span
			className="group relative inline-block max-w-full my-1 rounded-md border border-hairline bg-surface-elevated overflow-hidden hover:border-accent transition-colors cursor-zoom-in"
			data-testid="md-image-card"
			onClick={open}
		>
			<span className="relative block">
				<img
					src={resolveMediaSrc(src, sessionId)}
					alt={name}
					loading="lazy"
					onLoad={(e) => {
						const img = e.currentTarget;
						setDims({ w: img.naturalWidth, h: img.naturalHeight });
					}}
					onError={() => setFailed(true)}
					className="max-h-[200px] max-w-full w-auto object-contain block"
				/>
				<button
					type="button"
					title={t("blocks.fileViewer.zoomIn")}
					data-testid="md-image-zoom"
					onClick={(e) => {
						e.stopPropagation();
						open();
					}}
					className="absolute right-1.5 bottom-1.5 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-6 h-6 rounded bg-black/55 text-white hover:bg-black/70"
				>
					<Icon name="plus" size={13} />
				</button>
			</span>
			<span className="flex items-center gap-1.5 px-2 py-1 border-t border-hairline text-[calc(11px*var(--font-scale))] text-tertiary">
				<Icon name="image" size={11} />
				<span className="truncate max-w-[180px]">{name}</span>
				{dims && (
					<span className="shrink-0" data-testid="md-image-dims">
						{dims.w}×{dims.h}
					</span>
				)}
			</span>
		</span>
	);
}
