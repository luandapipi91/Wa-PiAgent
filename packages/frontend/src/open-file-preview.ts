import { useBrowserStore } from "./store/browser";
import { useSessionStore } from "./store/session";
import { isHtmlPath } from "./preview-url";

/**
 * 统一文件预览入口：html 文件用浏览器预览（BrowserPanel），其余用内置文件预览器。
 * 文件树双击、聊天文件标签（FilePill / 附件 / 修改清单）共用此分发。
 */
export function openFileOrPreview(path: string, sessionId: string): void {
	if (isHtmlPath(path)) {
		useBrowserStore.getState().openBrowser(path, sessionId);
	} else {
		useSessionStore.getState().openFilePreview(path, sessionId);
	}
}
