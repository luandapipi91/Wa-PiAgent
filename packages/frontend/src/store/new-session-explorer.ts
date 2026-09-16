// 新建会话页「文件浏览侧栏」开关状态：控制右侧文件树面板的展开/收起。
// 与会话页 store/explorer.ts 独立：新建页是独立视图，用户对「默认开不开」的偏好分开持久化。
// 默认收起（open=false），右上角 folder 开关 / 面板内 › 折叠按钮双入口 toggle。
import { create } from "zustand";

const STORAGE_KEY = "wa-pi:new-session-explorer-open";
const WIDTH_KEY = "wa-pi:new-session-explorer-width";

function loadOpen(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}
function saveOpen(v: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
	} catch {
		/* localStorage 不可用时静默降级 */
	}
}
function loadWidth(): number {
	try {
		const raw = localStorage.getItem(WIDTH_KEY);
		const n = raw ? Number(raw) : NaN;
		return Number.isFinite(n) ? n : 320;
	} catch {
		return 320;
	}
}
function saveWidth(v: number): void {
	try {
		localStorage.setItem(WIDTH_KEY, String(v));
	} catch {
		/* localStorage 不可用时静默降级 */
	}
}

interface NewSessionExplorerState {
	open: boolean;
	/** 面板宽度（px），默认 320，可拖拽调整 */
	width: number;
	/** 切换面板展开/收起，并持久化 */
	toggle: () => void;
	/** 直接设置开关状态，并持久化 */
	setOpen: (v: boolean) => void;
	/** 设置面板宽度，并持久化 */
	setWidth: (w: number) => void;
}

export const useNewSessionExplorerStore = create<NewSessionExplorerState>(
	(set) => ({
		open: loadOpen(),
		width: loadWidth(),
		toggle: () =>
			set((s) => {
				const next = !s.open;
				saveOpen(next);
				return { open: next };
			}),
		setOpen: (v) => {
			saveOpen(v);
			set({ open: v });
		},
		setWidth: (w) => {
			saveWidth(w);
			set({ width: w });
		},
	}),
);
