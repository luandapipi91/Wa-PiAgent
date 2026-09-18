import { create } from "zustand";
import type { FileChangeSnapshot } from "@wa-pi/shared";

/** 预览窗口模式：split=与聊天分屏；full=占满主内容区；float=独立窗口承载（可移出主窗口、与主窗口并行） */
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
	detachedRect: "hiagent.browser.detachedRect",
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

/** 浮窗默认尺寸+双向居中（无历史记录时的首次位置），必须在视口就绪后调用 */
export function defaultRect(): FloatRect {
	const w = Math.min(720, window.innerWidth - 80);
	const h = Math.min(480, window.innerHeight - 80);
	// 无历史记录时默认在视口正中弹出（用户期待；曾为右上角偏移）
	return clampRect({
		x: (window.innerWidth - w) / 2,
		y: (window.innerHeight - h) / 2,
		w,
		h,
	});
}

/**
 * 独立预览窗口的 rect clamp：**屏幕坐标**，因此不能复用 clampRect。
 * 与浮窗 rect 的区别：不夹进主窗口视口（允许副屏负坐标、允许宽/高大于主窗口），
 * 只保证「有限数值 + 不小于最小尺寸」——NaN/Infinity 会让 Electron setBounds 静默失败。
 */
export function clampDetachedRect(r: FloatRect): FloatRect {
	const num = (v: number, fallback: number) =>
		Number.isFinite(v) ? v : fallback;
	return {
		x: num(r.x, 0),
		y: num(r.y, 0),
		w: Math.max(MIN_W, num(r.w, MIN_W)),
		h: Math.max(MIN_H, num(r.h, MIN_H)),
	};
}

/** 读独立窗口位置尺寸（屏幕坐标）；无记录/形状非法返回 null（首次由主进程给默认位置） */
function loadDetachedRect(): FloatRect | null {
	try {
		const v = JSON.parse(localStorage.getItem(LS.detachedRect) ?? "");
		if (
			v &&
			[v.x, v.y, v.w, v.h].every(
				(n) => typeof n === "number" && Number.isFinite(n),
			)
		) {
			return clampDetachedRect(v);
		}
	} catch {
		/* 解析失败视为无记录 */
	}
	return null;
}

/**
 * 默认预览模式：桌面端（有 Electron 桥）默认就用独立窗口承载（需求：默认浮窗，
 * 首次打开预览直接弹独立窗口）；浏览器 dev 无桥时回退 split——float 在浏览器里
 * 没有承载者，会表现为「打开预览毫无反应」。
 * 抽成纯函数便于单测（loadMode 在模块加载期执行，单测难以重载模块）。
 */
export function defaultBrowserMode(hasElectronBridge: boolean): BrowserMode {
	return hasElectronBridge ? "float" : "split";
}

/** 当前环境有没有 Electron 独立预览窗口桥（浏览器 dev / 纯 web 环境没有） */
export function hasPreviewBridge(): boolean {
	return typeof window !== "undefined" && Boolean(window.waPiPreviewWin);
}

/**
 * 解析持久化的预览模式（读时降级）。
 *
 * float 的承载者是 Electron 独立窗口：无桥环境下主窗口只渲染一个气泡、窗口驱动
 * 直接 return，即「float 没有任何承载者」——表现为打开 html 预览毫无反应；又因为
 * 面板不渲染，用户还没有任何 UI 出路切回内嵌。而 `hiagent.browser.mode` 按 origin
 * 持久化，浏览器里可能留着早期的 float 偏好（float 曾是主窗口内的 DOM 浮层），
 * 于是升级后一打开预览就永久失效。
 *
 * 故无桥时把 float 一律降级为 split；**只降级读取，不改写 localStorage**——
 * 同一份偏好桌面端（有桥）仍需按 float 生效。
 */
export function resolveMode(
	stored: string | null,
	hasElectronBridge: boolean,
): BrowserMode {
	if (stored === "float") return hasElectronBridge ? "float" : "split";
	if (stored === "split" || stored === "full") return stored;
	// 无记录 / 非法值：走默认（桌面端独立窗口、浏览器分屏）
	return defaultBrowserMode(hasElectronBridge);
}

function loadMode(): BrowserMode {
	try {
		return resolveMode(localStorage.getItem(LS.mode), hasPreviewBridge());
	} catch {
		/* 隐私模式等场景读不到 localStorage，当无记录走默认 */
		return defaultBrowserMode(hasPreviewBridge());
	}
}

function loadRatio(): number {
	try {
		const v = Number(localStorage.getItem(LS.ratio));
		if (v >= 0.2 && v <= 0.8) return v;
		// pi-lens-ignore: error-swallowing
	} catch {
		/* 同上 */
	}
	return 0.5;
}

/** 无历史记录时返回 null：由渲染层在视口就绪后惰性计算居中（defaultRect）。
 *  不能在 module 加载期计算——应用重启时窗口可能仍在启动阶段，视口尺寸未就绪，
 *  算出的「居中」经 clampRect 退化为左上角，且此后无记录可覆盖，每次重启都复现。 */
function loadRect(): FloatRect | null {
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
		/* 解析失败视为无记录 */
	}
	return null;
}

function writeNow(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* 写不进就只在内存生效 */
	}
}

/**
 * 持久化防抖（毫秒）：分屏比例 setSplitRatio 在拖拽分隔条期间高频调用，
 * trailing debounce 把 60Hz 的 localStorage 写入合并为停手后一次。
 * <=0 时同步写入（测试用，保持断言确定性）。
 * 注：浮窗位置 setFloatRect 已改为 mouseup 直写，不走此防抖。
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

/** 单个会话的预览记忆：是否打开 + 内容（本地路径或外部网址，互斥）+ 是否最小化为气泡 */
export interface SessionPreview {
	open: boolean;
	path: string | null;
	/** 外部网址；与 path 互斥（两者都为空 = 空窗口） */
	url: string | null;
	minimized: boolean;
}

/** 未记录过预览的会话默认状态（空预览） */
const EMPTY_PREVIEW: SessionPreview = {
	open: false,
	path: null,
	url: null,
	minimized: false,
};

interface BrowserState {
	open: boolean;
	/** 当前预览的 html 绝对路径；null = 非本地预览（空窗口或外部网址） */
	path: string | null;
	/** 当前预览的外部网址；null = 非外部预览。与 path 互斥（打开本地会清空它，反之亦然） */
	externalUrl: string | null;
	/** 来源会话 id（供「代码」预览 / 分享 / 元素 chip 落入使用），可能为 null */
	sessionId: string | null;
	/** 刷新令牌：变化即重挂 iframe（BrowserPanel 传给 HtmlPreview 作 key）。
	 * 任务完成时被修改的预览文件经 maybeRefreshForFileChanges 自动递增；手动刷新按钮同源 bumpRefresh */
	refreshToken: number;
	mode: BrowserMode;
	splitRatio: number;
	/** null = 尚无记录（未定位过）；渲染层惰性居中后经 setFloatRect 固化 */
	floatRect: FloatRect | null;
	/** 独立预览窗口的屏幕坐标 rect（float 模式的承载窗口）；null = 无记录，由主进程给默认位置 */
	detachedRect: FloatRect | null;
	/** 浮动窗最小化为气泡（不持久化：重开预览时应直接显示窗口） */
	minimized: boolean;
	/** 气泡位置（localStorage 持久化） */
	bubblePos: BubblePos;
	/** 会话级预览记忆：sessionId → 该会话的预览状态（切换会话时按会话各自记住/恢复） */
	bySession: Record<string, SessionPreview>;
	openBrowser: (path?: string, sessionId?: string) => void;
	/** 打开外部网址（语义对齐 openBrowser：open=true、path=null、minimized=false、写 bySession） */
	openExternal: (url: string, sessionId?: string) => void;
	closeBrowser: () => void;
	/** 切换会话：先把当前会话预览记入 bySession，再恢复目标会话的预览（默认空预览） */
	activateSession: (sessionId: string | null) => void;
	setMode: (mode: BrowserMode) => void;
	setSplitRatio: (ratio: number) => void;
	setFloatRect: (rect: FloatRect) => void;
	setDetachedRect: (rect: FloatRect) => void;
	setMinimized: (minimized: boolean) => void;
	setBubblePos: (pos: BubblePos) => void;
	/** 同步当前预览路径（地址栏加载本地 html 时调用）：模式切换重挂面板后可从 store 恢复内容 */
	setPath: (path: string | null) => void;
	/** 同步当前预览的外部网址（地址栏输入网址时调用）：供形态切换 / 独立窗口同步恢复内容。
	 *  不改变开关与最小化状态——调用方是已打开面板的地址栏导航 */
	setExternalUrl: (url: string) => void;
	/** 把内容只记入某个会话的预览记忆，不动当前显示（agent 在非前台会话请求打开预览时用）。
	 *  切回该会话时由 activateSession 恢复 */
	rememberSessionPreview: (
		sessionId: string,
		target: { path?: string | null; url?: string | null },
	) => void;
	/** 递增刷新令牌 → iframe 重挂重新加载（手动刷新按钮） */
	bumpRefresh: () => void;
	/** 任务完成上报的修改清单命中「当前会话正在预览的文件」时递增刷新令牌。
	 * 只看面板当前显示的预览（open/path/sessionId）：未显示会话的预览记忆无需刷新——
	 * 切回时 iframe 挂载即加载磁盘最新内容（kernel 预览响应 no-store） */
	maybeRefreshForFileChanges: (
		sessionId: string | null,
		files: FileChangeSnapshot[],
	) => void;
	/** 判定修改清单是否命中当前预览（精确命中预览文件，或同目录含子目录的嵌套子页 html）。独立导出便于单测 */
	matchesFileChange: (files: FileChangeSnapshot[]) => boolean;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
	open: false,
	path: null,
	externalUrl: null,
	sessionId: null,
	refreshToken: 0,
	mode: loadMode(),
	splitRatio: loadRatio(),
	floatRect: loadRect(),
	detachedRect: loadDetachedRect(),
	minimized: false,
	bubblePos: loadBubblePos(),
	bySession: {},
	openBrowser: (path, sessionId) => {
		const sid = sessionId ?? null;
		return set((state) => ({
			open: true,
			path: path ?? null,
			// 本地/外部互斥：打开本地文件即清掉外部网址
			externalUrl: null,
			sessionId: sid,
			minimized: false,
			// 有归属会话时同步写入该会话的记忆
			bySession:
				sid == null
					? state.bySession
					: {
							...state.bySession,
							[sid]: { open: true, path: path ?? null, url: null, minimized: false },
						},
		}));
	},
	openExternal: (url, sessionId) => {
		const sid = sessionId ?? null;
		return set((state) => ({
			open: true,
			path: null,
			externalUrl: url,
			sessionId: sid,
			minimized: false,
			bySession:
				sid == null
					? state.bySession
					: {
							...state.bySession,
							[sid]: { open: true, path: null, url, minimized: false },
						},
		}));
	},
	closeBrowser: () =>
		set((state) => {
			const sid = state.sessionId;
			return {
				open: false,
				path: null,
				externalUrl: null,
				sessionId: null,
				minimized: false,
				// 关闭即清空该会话的记忆，切回时不弹出
				bySession:
					sid == null
						? state.bySession
						: {
								...state.bySession,
								[sid]: { open: false, path: null, url: null, minimized: false },
							},
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
						url: state.externalUrl,
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
				externalUrl: target.url,
				minimized: target.minimized,
			};
		}),
	setMode: (mode) => {
		// 无桥环境（浏览器）没有独立窗口承载者：float 会让预览彻底消失且无路可退，
		// 故直接按分屏落地；有桥时原样
		const next = mode === "float" && !hasPreviewBridge() ? "split" : mode;
		save(LS.mode, next);
		set({ mode: next });
	},
	setSplitRatio: (ratio) => {
		const clamped = clampRatio(ratio);
		save(LS.ratio, String(clamped));
		set({ splitRatio: clamped });
	},
	setFloatRect: (rect) => {
		const clamped = clampRect(rect);
		// 直写而非防抖：调用方是拖动 mouseup 一次性提交（低频），
		// 防抖会在「拖完立刻退出应用」时丢最后一次位置
		writeNow(LS.rect, JSON.stringify(clamped));
		set({ floatRect: clamped });
	},
	setDetachedRect: (rect) => {
		const clamped = clampDetachedRect(rect);
		// 同 setFloatRect：调用方是窗口 move/resize 结束的一次性上报，低频直写
		writeNow(LS.detachedRect, JSON.stringify(clamped));
		set({ detachedRect: clamped });
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
			// 本地/外部互斥：改看本地文件即清掉外部网址
			if (sid == null) return { path, externalUrl: null };
			const cur = state.bySession[sid] ?? EMPTY_PREVIEW;
			return {
				path,
				externalUrl: null,
				bySession: { ...state.bySession, [sid]: { ...cur, path, url: null } },
			};
		}),
	setExternalUrl: (url) =>
		set((state) => {
			const sid = state.sessionId;
			if (sid == null) return { externalUrl: url, path: null };
			const cur = state.bySession[sid] ?? EMPTY_PREVIEW;
			return {
				externalUrl: url,
				path: null,
				bySession: { ...state.bySession, [sid]: { ...cur, path: null, url } },
			};
		}),
	rememberSessionPreview: (sessionId, target) =>
		set((state) => ({
			bySession: {
				...state.bySession,
				[sessionId]: {
					open: true,
					path: target.path ?? null,
					url: target.url ?? null,
					minimized: false,
				},
			},
		})),
	setBubblePos: (pos) => {
		const clamped = clampBubblePos(pos);
		save(LS.bubble, JSON.stringify(clamped));
		set({ bubblePos: clamped });
	},
	bumpRefresh: () => set((s) => ({ refreshToken: s.refreshToken + 1 })),
	maybeRefreshForFileChanges: (sessionId, files) => {
		if (!sessionId || !files.length) return;
		const st = get();
		if (!st.open || st.sessionId !== sessionId || !st.path) return;
		// files 是 FileChangeSnapshot 对象数组，按 path 字段匹配（非字符串数组）
		if (!st.matchesFileChange(files)) return;
		set({ refreshToken: st.refreshToken + 1 });
	},
	matchesFileChange: (files) => {
		const st = get();
		if (!st.path) return false;
		const dir = st.path.slice(0, st.path.lastIndexOf("/") + 1); // 含尾斜杠的目录前缀
		return files.some((f) => {
			const p = f?.path;
			if (!p) return false;
			// ① 精确命中：预览文件本身被改
			if (p === st.path) return true;
			// ② 嵌套子页：预览 A.html 内 <iframe src="./B.html"> 引用的 B.html 被改 ——
			// 外层没变但渲染内容已过时。不解析 iframe 引用树（需 kernel 新接口），
			// 近似为「预览文件同目录（含子目录）的本地 html」：刷新幂等（重挂重拉），
			// 无关 html 多刷无害；精确性换零 kernel 改动。
			return (
				(p.endsWith(".html") || p.endsWith(".htm")) &&
				p.startsWith(dir) &&
				p.length > dir.length
			);
		});
	},
}));
