import { create } from "zustand";

/** 预览窗口模式：split=与聊天分屏；full=占满主内容区；float=浮动窗 */
export type BrowserMode = "split" | "full" | "float";

export interface FloatRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const LS = {
	mode: "hiagent.browser.mode",
	ratio: "hiagent.browser.splitRatio",
	rect: "hiagent.browser.floatRect",
} as const;

const MIN_W = 320;
const MIN_H = 240;

export function clampRatio(r: number): number {
	return Math.max(0.2, Math.min(0.8, r));
}

/** 浮动窗 rect clamp：最小 320x240，不超过视口，整体留在可视区内 */
export function clampRect(r: FloatRect): FloatRect {
	const w = Math.max(MIN_W, Math.min(window.innerWidth, r.w));
	const h = Math.max(MIN_H, Math.min(window.innerHeight, r.h));
	return {
		w,
		h,
		x: Math.max(0, Math.min(window.innerWidth - w, r.x)),
		y: Math.max(0, Math.min(window.innerHeight - h, r.y)),
	};
}

function defaultRect(): FloatRect {
	const w = Math.min(720, window.innerWidth - 80);
	const h = Math.min(480, window.innerHeight - 80);
	return clampRect({ x: window.innerWidth - w - 40, y: 60, w, h });
}

function loadMode(): BrowserMode {
	try {
		const v = localStorage.getItem(LS.mode);
		if (v === "full" || v === "float" || v === "split") return v;
	} catch {
		/* 隐私模式等场景读不到就当默认值 */
	}
	return "split";
}

function loadRatio(): number {
	try {
		const v = Number(localStorage.getItem(LS.ratio));
		if (v >= 0.2 && v <= 0.8) return v;
	} catch {
		/* 同上 */
	}
	return 0.5;
}

function loadRect(): FloatRect {
	try {
		const v = JSON.parse(localStorage.getItem(LS.rect) ?? "");
		if (
			v &&
			[v.x, v.y, v.w, v.h].every((n) => typeof n === "number" && Number.isFinite(n))
		) {
			return clampRect(v);
		}
	} catch {
		/* 解析失败用默认 */
	}
	return defaultRect();
}

function writeNow(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* 写不进就只在内存生效 */
	}
}

/**
 * 持久化防抖（毫秒）：拖拽期 setSplitRatio/setFloatRect 每帧调用，
 * trailing debounce 把 60Hz 的 localStorage 写入合并为停手后一次。
 * <=0 时同步写入（测试用，保持断言确定性）。
 */
let persistDebounceMs = 300;
export function setPersistDebounceMs(ms: number): void {
	persistDebounceMs = ms;
}

/** 每个 key 独立 timer：ratio 与 rect 互不争用 */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function save(key: string, value: string): void {
	const old = saveTimers.get(key);
	if (old !== undefined) clearTimeout(old);
	if (persistDebounceMs <= 0) {
		saveTimers.delete(key);
		writeNow(key, value);
		return;
	}
	saveTimers.set(
		key,
		setTimeout(() => {
			saveTimers.delete(key);
			writeNow(key, value);
		}, persistDebounceMs),
	);
}

interface BrowserState {
	open: boolean;
	/** 当前预览的 html 绝对路径；null = 空窗口 */
	path: string | null;
	/** 来源会话 id（供「代码」预览 / 分享 / 元素 chip 落入使用），可能为 null */
	sessionId: string | null;
	mode: BrowserMode;
	splitRatio: number;
	floatRect: FloatRect;
	openBrowser: (path?: string, sessionId?: string) => void;
	closeBrowser: () => void;
	setMode: (mode: BrowserMode) => void;
	setSplitRatio: (ratio: number) => void;
	setFloatRect: (rect: FloatRect) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
	open: false,
	path: null,
	sessionId: null,
	mode: loadMode(),
	splitRatio: loadRatio(),
	floatRect: loadRect(),
	openBrowser: (path, sessionId) =>
		set({ open: true, path: path ?? null, sessionId: sessionId ?? null }),
	closeBrowser: () => set({ open: false, path: null, sessionId: null }),
	setMode: (mode) => {
		save(LS.mode, mode);
		set({ mode });
	},
	setSplitRatio: (ratio) => {
		const clamped = clampRatio(ratio);
		save(LS.ratio, String(clamped));
		set({ splitRatio: clamped });
	},
	setFloatRect: (rect) => {
		const clamped = clampRect(rect);
		save(LS.rect, JSON.stringify(clamped));
		set({ floatRect: clamped });
	},
}));
