import { useBrowserStore } from "./store/browser";
import { useSessionStore } from "./store/session";
import { isHtmlPath } from "./preview-url";
import { mediaKindOf } from "./components/blocks/file-path";

/**
 * 统一文件预览入口：html 文件用浏览器预览（BrowserPanel）；图片/视频用媒体画廊
 * （MediaPreviewModal——与聊天里点图同一个窗，自带同目录缩略图条与左右切换）；
 * 其余文件用内置文件预览器（FilePreviewModal）。
 * 文件树双击、聊天文件标签（FilePill / 附件 / 修改清单）共用此分发。
 */
export function openFileOrPreview(path: string, sessionId: string): void {
	if (isHtmlPath(path)) {
		useBrowserStore.getState().openBrowser(path, sessionId);
		return;
	}
	const kind = mediaKindOf(path);
	if (kind) {
		// 单元素清单起步：画廊打开后会按当前文件所在目录重建清单（useDirGallery），
		// 目录不可列（远程/工作区外等）时退化为只显示这一张。
		const name = path.replace(/\\/g, "/").split("/").pop() || path;
		useSessionStore
			.getState()
			.openMediaPreview([{ src: path, kind, name }], 0, sessionId);
		return;
	}
	useSessionStore.getState().openFilePreview(path, sessionId);
}
