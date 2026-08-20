import { create } from "zustand";

interface BrowserState {
	open: boolean;
	/** 当前预览的 html 绝对路径；null = 空窗口 */
	path: string | null;
	/** 来源会话 id（供「代码」预览 / 分享使用），可能为 null */
	sessionId: string | null;
	openBrowser: (path?: string, sessionId?: string) => void;
	closeBrowser: () => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
	open: false,
	path: null,
	sessionId: null,
	openBrowser: (path, sessionId) =>
		set({ open: true, path: path ?? null, sessionId: sessionId ?? null }),
	closeBrowser: () => set({ open: false, path: null, sessionId: null }),
}));
