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
	bubble: "hiagent.browser.bubblePos",
} as const;

const MIN_W = 320;
const MIN_H = 240;
/** 气泡边长（px），与 FloatBubble 渲染尺寸一致 */
export const BUBBLE_SIZE = 44;

export interface BubblePos {
	x: number;
	y: number;
}

/** 气泡位置 clamp：整体留在视口内 */
export function clampBubblePos(p: BubblePos): BubblePos {
	return {
		x: Math.max(0, Math.min(window.innerWidth - BUBBLE_SIZE, p.x)),
		y: Math.max(0, Math.min(window.innerHeight - BUBBLE_SIZE, p.y)),
	};
}

function defaultBubblePos(): BubblePos {
	return clampBubblePos({
		x: window.innerWidth - BUBBLE_SIZE - 24,
		y: window.innerHeight - BUBBLE_SIZE - 24,
	});
}

function loadBubblePos(): BubblePos {
	try {
		const v = JSON.parse(localStorage.getItem(LS.bubble) ?? "");
		if (
			v &&
			[v.x, v.y].every((n) => typeof n === "number" && Number.isFinite(n))
		) {
			return clampBubblePos(v);
		}
	} catch {
		/* 解析失败用默认 */
	}
	return defaultBubblePos();
}

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
			[v.x, v.y, v.w, v.h].every(
				(n) => typeof n === "number" && Number.isFinite(n),
			)
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

/** 单个会话的预览记忆：是否打开 + 内容路径 + 是否最小化为气泡 */
export interface SessionPreview {
	open: boolean;
	path: string | null;
	minimized: boolean;
}

/** 未记录过预览的会话默认状态（空预览） */
const EMPTY_PREVIEW: SessionPreview = {
	open: false,
	path: null,
	minimized: false,
};

interface BrowserState {
	open: boolean;
	/** 当前预览的 html 绝对路径；null = 空窗口 */
	path: string | null;
	/** 来源会话 id（供「代码」预览 / 分享 / 元素 chip 落入使用），可能为 null */
	sessionId: string | null;
	mode: BrowserMode;
	splitRatio: number;
	floatRect: FloatRect;
	/** 浮动窗最小化为气泡（不持久化：重开预览时应直接显示窗口） */
	minimized: boolean;
	/** 气泡位置（localStorage 持久化） */
	bubblePos: BubblePos;
	/** 会话级预览记忆：sessionId → 该会话的预览状态（切换会话时按会话各自记住/恢复） */
	bySession: Record<string, SessionPreview>;
	openBrowser: (path?: string, sessionId?: string) => void;
	closeBrowser: () => void;
	/** 切换会话：先把当前会话预览记入 bySession，再恢复目标会话的预览（默认空预览） */
	activateSession: (sessionId: string | null) => void;
	setMode: (mode: BrowserMode) => void;
	setSplitRatio: (ratio: number) => void;
	setFloatRect: (rect: FloatRect) => void;
	setMinimized: (minimized: boolean) => void;
	setBubblePos: (pos: BubblePos) => void;
	/** 同步当前预览路径（地址栏加载本地 html 时调用）：模式切换重挂面板后可从 store 恢复内容 */
	setPath: (path: string | null) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
	open: false,
	path: null,
	sessionId: null,
	mode: loadMode(),
	splitRatio: loadRatio(),
	floatRect: loadRect(),
	minimized: false,
	bubblePos: loadBubblePos(),
	bySession: {},
	openBrowser: (path, sessionId) => {
		const sid = sessionId ?? null;
		return set((state) => ({
			open: true,
			path: path ?? null,
			sessionId: sid,
			minimized: false,
			// 有归属会话时同步写入该会话的记忆
			bySession:
				sid != null
					? {
							...state.bySession,
							[sid]: { open: true, path: path ?? null, minimized: false },
						}
					: state.bySession,
		}));
	},
	closeBrowser: () =>
		set((state) => {
			const sid = state.sessionId;
			return {
				open: false,
				path: null,
				sessionId: null,
				minimized: false,
				// 关闭即清空该会话的记忆，切回时不弹出
				bySession:
					sid != null
						? {
								...state.bySession,
								[sid]: { open: false, path: null, minimized: false },
							}
						: state.bySession,
			};
		}),
	activateSession: (sessionId) =>
		set((state) => {
			// 先记住当前显示预览所属的会话（若有），再切换并恢复目标会话的预览
			const oldSid = state.sessionId;
			let bySession = state.bySession;
			if (oldSid != null) {
				bySession = {
					...bySession,
					[oldSid]: {
						open: state.open,
						path: state.path,
						minimized: state.minimized,
					},
				};
			}
			const target =
				sessionId != null && bySession[sessionId]
					? bySession[sessionId]
					: EMPTY_PREVIEW;
			return {
				bySession,
				sessionId,
				open: target.open,
				path: target.path,
				minimized: target.minimized,
			};
		}),
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
	setMinimized: (minimized) =>
		set((state) => {
			const sid = state.sessionId;
			if (sid == null) return { minimized };
			const cur = state.bySession[sid] ?? EMPTY_PREVIEW;
			return {
				minimized,
				bySession: { ...state.bySession, [sid]: { ...cur, minimized } },
			};
		}),
	setPath: (path) =>
		set((state) => {
			const sid = state.sessionId;
			if (sid == null) return { path };
			const cur = state.bySession[sid] ?? EMPTY_PREVIEW;
			return { path, bySession: { ...state.bySession, [sid]: { ...cur, path } } };
		}),
	setBubblePos: (pos) => {
		const clamped = clampBubblePos(pos);
		save(LS.bubble, JSON.stringify(clamped));
		set({ bubblePos: clamped });
	},
}));
