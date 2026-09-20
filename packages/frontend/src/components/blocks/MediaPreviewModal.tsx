import { useEffect } from "react";
import { useSessionStore } from "../../store/session";
import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";
import { MODAL_SIZE_KEYS } from "../ui/modal-size";
import { MODAL_POS_KEYS } from "../ui/modal-position";
import { Icon } from "../ui/Icon";
import { ZoomableImage } from "./ZoomableImage";
import { resolveCopyPath, resolveMediaSrc } from "./media-utils";
import { useToastStore } from "../../store/toast";
import {
	copyImageToClipboard,
	copyToClipboard,
	imageUrlToPngBlob,
} from "../../util/clipboard";

/** 全局媒体预览弹窗（画廊）：常驻挂载在 App 根，从 session store 读 mediaPreview。
 *  左右箭头 + 键盘 ←/→ 循环切换（Esc 关闭由 Modal 自带）；底部缩略图条点击跳转；
 *  单媒体退化为纯预览（隐藏箭头/缩略图条/计数器）。图片用 ZoomableImage 缩放视口，
 *  视频全尺寸 <video controls autoplay>。点遮罩不关闭（与 FilePreviewModal 同款防误触）。
 *  按住标题栏可拖动窗口移动位置，右下角手柄可拖动调整大小；尺寸与位置均持久化，重开保持。 */
export function MediaPreviewModal() {
	const preview = useSessionStore((s) => s.mediaPreview);
	const { t } = useTranslation();
	const addToast = useToastStore((s) => s.add);
	const index = preview?.index ?? 0;
	const count = preview?.items.length ?? 0;

	// 键盘 ←/→ 循环切换（仅多媒体时绑定）
	useEffect(() => {
		if (!preview || count < 2) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") {
				useSessionStore
					.getState()
					.setMediaPreviewIndex((index - 1 + count) % count);
			} else if (e.key === "ArrowRight") {
				useSessionStore.getState().setMediaPreviewIndex((index + 1) % count);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [preview, index, count]);

	if (!preview) return null;
	const close = () => useSessionStore.getState().closeMediaPreview();
	const item = preview.items[index];
	const src = resolveMediaSrc(item.src, preview.sessionId);
	const go = (d: number) =>
		useSessionStore.getState().setMediaPreviewIndex((index + d + count) % count);

	// 复制：图片 → canvas 转 PNG 写剪贴板；视频/其他 → 复制路径（本地路径解析为绝对路径）
	const copy = async () => {
		try {
			if (item.kind === "image") {
				await copyImageToClipboard(await imageUrlToPngBlob(src));
			} else {
				await copyToClipboard(resolveCopyPath(item.src, preview.sessionId));
			}
			addToast(t("common.copiedToClipboard"), "success");
		} catch {
			addToast(t("common.copyFailed"), "error");
		}
	};

	return (
		<Modal
			onClose={close}
			width="90vw"
			height="85vh"
			resizable
			sizeStorageKey={MODAL_SIZE_KEYS.mediaPreview}
			draggable
			positionStorageKey={MODAL_POS_KEYS.mediaPreview}
			data-testid="media-preview-modal"
		>
			<div className="flex flex-col h-full">
				{/* 头部：文件名 · i/N 计数 · 复制 · 关闭（按住可拖动整个窗口） */}
				<div
					className="flex items-center gap-2 px-3 py-2 border-b border-hairline bg-surface"
					data-modal-drag-handle=""
				>
					<span className="flex-1 truncate text-[calc(12px*var(--font-scale))] text-secondary inline-flex items-center gap-1.5">
						<Icon name={item.kind === "image" ? "image" : "play"} size={13} />
						{item.name}
						{count > 1 && (
							<span className="text-tertiary" data-testid="media-counter">
								{index + 1} / {count}
							</span>
						)}
					</span>
					<button
						className="fv-btn"
						onClick={copy}
						title={
							item.kind === "image"
								? t("blocks.fileViewer.copyImage")
								: t("blocks.fileViewer.copyPath")
						}
						data-testid="media-copy"
					>
						<Icon name="clipboard" size={12} />
					</button>
					<button className="fv-btn" onClick={close} title={t("common.close")}>
						<Icon name="x" size={12} />
					</button>
				</div>
				{/* 主体：图片缩放视口 / 视频全尺寸播放；key=index 切换时重置缩放与播放状态 */}
				<div className="flex-1 relative min-h-0 flex">
					{item.kind === "image" ? (
						<ZoomableImage key={index} src={src} alt={item.name} />
					) : (
						<div className="flex-1 bg-black flex items-center justify-center p-2.5">
							<video
								key={index}
								controls
								autoPlay
								src={src}
								className="max-w-full max-h-full"
								data-testid="media-video"
							/>
						</div>
					)}
					{count > 1 && (
						<>
							<button
								type="button"
								data-testid="media-prev"
								onClick={() => go(-1)}
								className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/55 text-white flex items-center justify-center hover:bg-black/70"
							>
								<Icon name="chevron-right" size={16} className="rotate-180" />
							</button>
							<button
								type="button"
								data-testid="media-next"
								onClick={() => go(1)}
								className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/55 text-white flex items-center justify-center hover:bg-black/70"
							>
								<Icon name="chevron-right" size={16} />
							</button>
						</>
					)}
				</div>
				{/* 底部缩略图条：仅多媒体时显示，点击跳转 */}
				{count > 1 && (
					<div
						className="flex items-center gap-1.5 px-3 py-2 border-t border-hairline bg-surface overflow-x-auto"
						data-testid="media-thumbs"
					>
						{preview.items.map((it, i) => (
							<button
								key={i}
								type="button"
								onClick={() =>
									useSessionStore.getState().setMediaPreviewIndex(i)
								}
								className={`shrink-0 w-12 h-12 rounded border overflow-hidden flex items-center justify-center bg-canvas text-tertiary ${
									i === index ? "border-accent" : "border-hairline"
								}`}
								title={it.name}
							>
								{it.kind === "image" ? (
									<img
										src={resolveMediaSrc(it.src, preview.sessionId)}
										alt={it.name}
										loading="lazy"
										className="w-full h-full object-cover"
									/>
								) : (
									<Icon name="play" size={16} />
								)}
							</button>
						))}
					</div>
				)}
			</div>
		</Modal>
	);
}
