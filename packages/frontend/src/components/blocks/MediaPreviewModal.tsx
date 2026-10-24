import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../store/session";
import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";
import { MODAL_SIZE_KEYS } from "../ui/modal-size";
import { MODAL_POS_KEYS } from "../ui/modal-position";
import { ThumbStrip } from "./ThumbStrip";
import { useDirGallery } from "./useDirGallery";
import { Icon } from "../ui/Icon";
import { ZoomableImage, type ImageTransform, type ZoomControls } from "./ZoomableImage";
import {
	isAnnotatableImageSrc,
	resolveCopyPath,
	resolveMediaSrc,
	sameFilePath,
} from "./media-utils";
import {
	ImageAnnotator,
	type AnnotatorHandle,
} from "./image-annotator/ImageAnnotator";
import { mimeForExt } from "./image-annotator/draw";
import { overwriteFile } from "../../fs-client";
import { useImageRevisionStore } from "../../store/image-revision";
import { useToastStore } from "../../store/toast";
import {
	copyImageToClipboard,
	copyToClipboard,
	imageUrlToPngBlob,
} from "../../util/clipboard";

/** 全局媒体预览弹窗（画廊）：常驻挂载在 App 根，从 session store 读 mediaPreview。
 *  左右箭头 + 键盘 ←/→ 循环切换（Esc 关闭由 Modal 自带）；底部缩略图条点击跳转；
 *  单媒体退化为纯预览（隐藏箭头/缩略图条/计数器）。图片用 ZoomableImage 缩放视口，
 *  图片顶部栏（计数之后）提供 − % + 缩放控件与键盘 +/−/0（视频项不显示）；
 *  视频全尺寸 <video controls autoplay>。点遮罩不关闭（与 FilePreviewModal 同款防误触）。
 *  按住标题栏可拖动窗口移动位置，右下角手柄可拖动调整大小；尺寸与位置均持久化，重开保持。 */
/** 某一项是否可标注：图片 + annotatablePath 指向同一文件 + 扩展名在白名单 */
function annotatableItem(
	preview: NonNullable<
		ReturnType<typeof useSessionStore.getState>["mediaPreview"]
	>,
	index: number,
): boolean {
	const item = preview.items[index];
	return (
		!!item &&
		item.kind === "image" &&
		!!preview.annotatablePath &&
		sameFilePath(preview.annotatablePath, item.src) &&
		isAnnotatableImageSrc(item.src)
	);
}

export function MediaPreviewModal() {
	const preview = useSessionStore((s) => s.mediaPreview);
	const { t } = useTranslation();
	const addToast = useToastStore((s) => s.add);
	// 标注保存后 revision 变化 → 主图与缩略图条换上带新版本号的 URL（键与 bump 同一口径：item.src）
	const revisions = useImageRevisionStore((s) => s.revisions);
	// 同目录画廊：打开时按当前文件所在目录重建 items（图片 + 视频，名称自然序）
	useDirGallery();
	const index = preview?.index ?? 0;
	const count = preview?.items.length ?? 0;
	// 缩放命令与百分比：zoom 状态在 ZoomableImage 内部，命令经 ref 下发、百分比经回调上报
	const zoomRef = useRef<ZoomControls | null>(null);
	const [zoom, setZoom] = useState(1);
	// 当前视角（缩放 + 平移）：预览与标注态共用。用户在外面放大到某处后点笔，
	// 编辑态要从同一视角开始，不能重置回 100%/居中；退出编辑时再把新视角交回预览。
	const transformRef = useRef<ImageTransform>({ zoom: 1, pan: { x: 0, y: 0 } });
	const [annotatorZoom, setAnnotatorZoom] = useState(1);
	// 当前项是否图片：缩放控件与 +/−/0 快捷键仅对图片生效（视频无需缩放）
	const isImage = preview?.items[index]?.kind === "image";
	// 切换图片时视角归零：沿用上一张的平移量会错位
	const itemSrc = preview?.items[index]?.src;
	useEffect(() => {
		transformRef.current = { zoom: 1, pan: { x: 0, y: 0 } };
		setAnnotatorZoom(1);
	}, [itemSrc]);
	// 标注态：主体换成 ImageAnnotator，顶栏隐藏缩放/复制/翻页；组件常驻挂载，
	// 关闭或重新打开预览（openId 变化）时自动退出标注态
	const [annotating, setAnnotating] = useState(false);
	// 标注组件句柄：顶栏 ✕ 在标注态要请它走自己的丢弃确认，而不是直接关窗
	const annotatorRef = useRef<AnnotatorHandle | null>(null);
	// 本次退出标注是否来自顶栏 ✕（丢弃确认后要跟着关窗；用户取消丢弃则撤销）
	const pendingClose = useRef(false);
	const openId = preview?.openId ?? null;
	useEffect(() => {
		// 上传截图后点缩略图（autoAnnotate）：打开即进标注态，不必再点一次笔；
		// 只有当前项确实可标注才进，否则会留下「顶栏全隐藏却没有画布」的僵死态
		setAnnotating(
			!!preview?.autoAnnotate && annotatableItem(preview, preview.index),
		);
		pendingClose.current = false;
	}, [openId]);

	// 键盘 ←/→ 循环切换（仅多媒体时绑定；标注态交给标注组件）
	useEffect(() => {
		if (!preview || count < 2 || annotating) return;
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
	}, [preview, index, count, annotating]);

	// 键盘 + / − / 0：放大、缩小、重置（仅图片项；与 ←/→ 翻页、Esc 关闭并存）
	useEffect(() => {
		if (!isImage || annotating) return;
		const onKey = (e: KeyboardEvent) => {
			// 美式键盘上 “+” 需 Shift，主键位是 “=”，同样视为放大
			if (e.key === "+" || e.key === "=") zoomRef.current?.zoomIn();
			else if (e.key === "-") zoomRef.current?.zoomOut();
			else if (e.key === "0") zoomRef.current?.reset();
			else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [isImage, annotating]);

	if (!preview) return null;
	const item = preview.items[index];
	const src = resolveMediaSrc(item.src, preview.sessionId, revisions[item.src] ?? 0);
	const go = (d: number) =>
		useSessionStore.getState().setMediaPreviewIndex((index + d + count) % count);

	// 关闭：非标注态直接关；标注态先请标注组件走丢弃确认，确认丢弃后再关窗。
	// 只在「弹出丢弃确认」时记关窗意图——保存中被拒（refused）不记，
	// 否则意图残留会让后续正常的取消丢弃误关窗。
	const requestClose = () => {
		if (!inAnnotator) {
			useSessionStore.getState().closeMediaPreview();
			return;
		}
		// 标注器未挂载（标注条件在期间失效等）：否则 `annotating` 为真而句柄为空时 ✕/Esc 彻底关不掉窗
		if (!annotatorRef.current) {
			pendingClose.current = false;
			useSessionStore.getState().closeMediaPreview();
			return;
		}
		const result = annotatorRef.current.requestCancel();
		if (result === "exited") {
			useSessionStore.getState().closeMediaPreview();
			return;
		}
		pendingClose.current = result === "confirming";
	};
	// 退出标注态（标注组件确认后的回调）：本次退出由 ✕ 发起时一并关窗
	const exitAnnotating = () => {
		const closeRequested = pendingClose.current;
		pendingClose.current = false;
		setAnnotating(false);
		if (closeRequested) useSessionStore.getState().closeMediaPreview();
	};

	// 可标注：本次打开允许标注，且当前项就是那张图（真实可写由内核二次校验）
	const canAnnotate = annotatableItem(preview, index);
	// 真正处于标注界面：annotating 只是意图，当前项不可标注时按普通预览渲染（防僵死态）
	const inAnnotator = annotating && canAnnotate;
	// 标注导出的 mime：按扩展名映射（白名单内必有值，回退 png）
	const annotatorMime =
		mimeForExt(item.src.slice(item.src.lastIndexOf(".") + 1)) ?? "image/png";

	// 保存标注：覆盖 uploads 原图 → 版本号自增（预览/缩略图按它刷新）→ 退出标注态；
	// 失败只提示并保留标注态，shapes 在 ImageAnnotator 内可继续编辑重试
	const saveAnnotated = async (blob: Blob) => {
		try {
			await overwriteFile(item.src, blob);
			useImageRevisionStore.getState().bumpImageRevision(item.src);
			addToast(t("blocks.imageAnnotator.saved"), "success");
			setAnnotating(false);
		} catch {
			addToast(t("blocks.imageAnnotator.saveFailed"), "error");
		}
	};

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
			onClose={requestClose}
			closeOnEsc={!inAnnotator}
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
					{/* 缩放控件：计数之后、复制按钮之前，仅图片项（− % +）；标注态下控标注画布同一套 zoom */}
					{isImage && (
						<>
							<button
								className="fv-btn"
								onClick={() =>
									inAnnotator
										? annotatorRef.current?.zoomOut()
										: zoomRef.current?.zoomOut()
								}
								title={t("blocks.fileViewer.zoomOut")}
								data-testid="media-zoom-out"
							>
								<Icon name="minus" size={12} />
							</button>
							<span
								className="text-[calc(11px*var(--font-scale))] text-tertiary w-10 text-center"
								data-testid="media-zoom-percent"
							>
								{Math.round((inAnnotator ? annotatorZoom : zoom) * 100)}%
							</span>
							<button
								className="fv-btn"
								onClick={() =>
									inAnnotator
										? annotatorRef.current?.zoomIn()
										: zoomRef.current?.zoomIn()
								}
								title={t("blocks.fileViewer.zoomIn")}
								data-testid="media-zoom-in"
							>
								<Icon name="plus" size={12} />
							</button>
						</>
					)}
					{!inAnnotator && (
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
					)}
					<button
						className="fv-btn"
						onClick={requestClose}
						title={t("common.close")}
						data-testid="media-close"
					>
						<Icon name="x" size={12} />
					</button>
				</div>
				{/* 主体：标注画布 / 图片缩放视口 / 视频全尺寸播放；key=index 切换时重置缩放与播放状态 */}
				<div className="flex-1 relative min-h-0 flex">
					{inAnnotator ? (
						<ImageAnnotator
							src={src}
							alt={item.name}
							mime={annotatorMime}
							apiRef={annotatorRef}
							// 接着外面的缩放/位置继续编辑，不从 100% 重新开始
							initialZoom={transformRef.current.zoom}
							initialPan={transformRef.current.pan}
							onZoomChange={setAnnotatorZoom}
							onTransformChange={(tr) => {
								transformRef.current = tr;
							}}
							onCancel={exitAnnotating}
							onDiscardCancelled={() => {
								pendingClose.current = false;
							}}
							onSave={saveAnnotated}
							// 导出阶段失败（toBlob 返回 null 等）：onSave 不会被调到，单独复用保存失败提示
							onExportError={() =>
								addToast(t("blocks.imageAnnotator.saveFailed"), "error")
							}
						/>
					) : item.kind === "image" ? (
						<ZoomableImage
							key={index}
							src={src}
							alt={item.name}
							controlsRef={zoomRef}
							onZoomChange={setZoom}
							// 从标注态退出时沿用编辑时的视角，画面不跳
							initialZoom={transformRef.current.zoom}
							initialPan={transformRef.current.pan}
							onTransformChange={(tr) => {
								transformRef.current = tr;
							}}
						/>
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
					{/* 标注入口：浮在图片右下角的圆形笔按钮（仅发送前附件图片；标注态隐藏）。
					    默认半透明不遮挡画面，悬停时放大并变清晰；鼠标按下不传给下层缩放/拖拽视口。 */}
					{canAnnotate && !inAnnotator && (
						<button
							type="button"
							onClick={() => {
								pendingClose.current = false;
								setAnnotating(true);
							}}
							onMouseDown={(e) => e.stopPropagation()}
							title={t("blocks.imageAnnotator.annotate")}
							aria-label={t("blocks.imageAnnotator.annotate")}
							data-testid="media-annotate"
							className="absolute bottom-5 right-5 z-10 flex h-[70px] w-[70px] cursor-pointer items-center justify-center rounded-full border border-white/25 bg-black/30 text-white opacity-60 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-md transition-[transform,opacity,background-color] duration-200 ease-out hover:scale-110 hover:bg-black/45 hover:opacity-100 active:scale-105"
						>
							<Icon name="edit" size={26} strokeWidth={2} />
						</button>
					)}
					{count > 1 && !inAnnotator && (
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
				{/* 底部缩略图条：仅多媒体且非标注态时显示，点击跳转（同目录可能有上千项，条内虚拟滚动） */}
				{count > 1 && !inAnnotator && (
					<ThumbStrip
						items={preview.items}
						index={index}
						sessionId={preview.sessionId}
						onSelect={(i) => {
							useSessionStore.getState().setMediaPreviewIndex(i);
						}}
					/>
				)}
			</div>
		</Modal>
	);
}
