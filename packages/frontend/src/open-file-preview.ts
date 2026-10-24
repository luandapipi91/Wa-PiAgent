import { useBrowserStore } from "./store/browser";
import { useSessionStore } from "./store/session";
import { isHtmlPath } from "./preview-url";
import { isAnnotatableImageSrc, mediaKindOf } from "./components/blocks/file-path";

/**
 * 统一文件预览入口：html 文件用浏览器预览（BrowserPanel）；图片/视频用媒体画廊
 * （MediaPreviewModal——与聊天里点图同一个窗，自带同目录缩略图条与左右切换）；
 * 其余文件用内置文件预览器（FilePreviewModal）。
 * 文件树双击、聊天文件标签（FilePill / 附件 / 修改清单）共用此分发。
 *
 * 标注入口：只要图片落在 `.wa-pi/uploads` 下且是 png/jpg/jpeg/webp（isAnnotatableImageSrc），
 * 任何入口打开都能在预览窗右下角看到笔按钮——附件缩略图、文件树双击、路径胶囊一致。
 * 覆盖保存只写 uploads，不会误改用户工程文件；聊天消息内联图片走另一条入口
 * （MarkdownImage → openMediaPreview），不在此列。
 * opts.annotatable === false 可显式关掉（保留给"只预览不可改"的调用方）。
 */
export function openFileOrPreview(
	path: string,
	sessionId: string,
	opts?: { annotatable?: boolean },
): void {
	if (isHtmlPath(path)) {
		useBrowserStore.getState().openBrowser(path, sessionId);
		return;
	}
	const kind = mediaKindOf(path);
	if (kind) {
		// 单元素清单起步：画廊打开后会按当前文件所在目录重建清单（useDirGallery），
		// 目录不可列（远程/工作区外等）时退化为只显示这一张。
		const name = path.replace(/\\/g, "/").split("/").pop() || path;
		const annotatablePath =
			opts?.annotatable === false || !isAnnotatableImageSrc(path)
				? undefined
				: path;
		useSessionStore
			.getState()
			.openMediaPreview([{ src: path, kind, name }], 0, sessionId, {
				annotatablePath,
			});
		return;
	}
	useSessionStore.getState().openFilePreview(path, sessionId);
}
