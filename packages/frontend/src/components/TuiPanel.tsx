// 扩展 TUI 面板（ctx.ui.custom 兼容）在界面上的三态浮窗：
//   expanded —— 展开态：标题栏可拖动、右下角可缩放、键盘/鼠标锁给面板；
//   badge    —— 挂件态：右上角预览卡片（实时帧缩略），点主体展开；
//   pill     —— 胶囊态：最小挂件，只剩标题 + 取消。
//
// 三态的位置：一律**左缘锚定**（left/top = 元素左/上缘相对容器的偏移），且
// 展开态与收起态（挂件 + 胶囊）各自一份——两者宽度不同（680 / 268），
// 共享一份 x 在左缘锚定下没法同时贴紧容器右缘。位置在 `rect` / `pos` 两个 state 里。
//
// 职责边界：本组件只负责「画 + 收输入」。
// - 面板数据来自 store/tui-panel（帧由 SSE 的 extension_tui_frame 写入）；
// - 生命周期归 kernel：✕ 只发 cancel，面板消失由 kernel 回推 close 事件驱动（规格 §5）；
// - 复制路径：面板内容本来就是 DOM 文本，用户**拖选 + Cmd+C** 即可复制（浏览器原生选择），
//   因此 body 上不阻止默认行为、也不向 TUI 转发拖拽序列（规格 §7.5 的偏离，见 onBodyMouseDown）；
// - widget 面板不进本组件（走既有 extension_widget → ExtWidgetDock，规格 §6.4），
//   只有它的宽度上报复用本文件的 CELL 常量与上报函数。
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ClipboardEvent as ReactClipboardEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
} from "react";
import { isScrolledAwayFromBottom } from "../lib/tui-follow";
import type { ExtensionTuiSnapshotResult } from "@wa-pi/shared";
import { useTuiPanelStore } from "../store/tui-panel";
import { useTranslation } from "../i18n/useTranslation";
import { api } from "../api-client";
import { encodeKey, encodeMouse, encodePaste } from "../lib/tui-keys";
import { AnsiText } from "./ui/AnsiText";

/** 展开态默认尺寸（px），与规格 §7.1 一致 */
const EXPANDED_SIZE = { width: 680, height: 380 };
/** 缩放下限（px）：再小就看不到帧内容 */
const MIN_SIZE = { width: 320, height: 200 };
/**
 * 面板内一格（终端单元格）的**兜底**宽高（px）：等宽字体 12px / 19.4px 行高下的定值。
 *
 * 格宽的真实值由挂载时用隐藏探针 span 实测（`measureCellWidth`）——字体/字号/窗口缩放一变，
 * 硬编码就会与实际前进宽失配，鼠标列换算与光标方块会整体偏移。行高不是字体度量，由本常量锁定
 * （每行 style.height），所以只实测宽。实测失败（无布局的宿主、字体未就绪）才回退到此值。
 */
export const CELL = { width: 7.2, height: 19.4 };
/** 帧文本区左右内边距（px），列换算前要先减去它 */
const BODY_PAD_X = 12;
/** 量宽探针的字符数：越多越能摊薄单字符的亚像素取整误差 */
const METRIC_PROBE_CHARS = 20;
/** 挂件预览最多显示的行数 */
const BADGE_PREVIEW_LINES = 5;
/** 挂件态卡片宽度（px）：位置只锚右缘，宽度固定 */
const BADGE_WIDTH = 268;
/** 拖动与点击的位移阈值（px，与 FloatBubble 同口径） */
const DRAG_THRESHOLD = 5;
/** 展开态位置尺寸的持久化键（窗口级，不按会话区分：位置是用户对浮窗的偏好） */
const LS_RECT = "hiagent.tuiPanel.rect";
/**
 * 收起态（挂件 + 胶囊）位置的持久化键：与展开态**分开存**。
 * 挂件 268 宽、展开 680 宽，共享一份 x 时左缘锚定下小卡片贴不住右缘；分开存也就不会有切态跳位。
 */
const LS_COLLAPSED = "hiagent.tuiPanel.collapsed";

interface PanelRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * 收起态（挂件 + 胶囊）的位置：只有左缘与上缘。
 * 挂件与胶囊共用这一份（两者高度差小、切换时视觉上不跳），胶囊宽度由内容决定
 * （标题 max-w 220 + 取消按钮 + 内边距 ≈ 266px ≤ 挂件宽），所以复用挂件的默认 x 也能贴近右缘。
 */
interface PanelPos {
	x: number;
	y: number;
}

/** 定位上下文（聊天列容器）的尺寸 */
interface Size {
	width: number;
	height: number;
}

/** 像素宽度 → 终端列数（非有限值返回 0，由调用方决定是否上报） */
export function colsFromWidth(px: number, cellWidth = CELL.width): number {
	return Number.isFinite(px) ? Math.max(0, Math.floor(px / cellWidth)) : 0;
}

/** 像素高度 → 终端行数（非有限值返回 0） */
export function rowsFromHeight(px: number): number {
	return Number.isFinite(px) ? Math.max(0, Math.floor(px / CELL.height)) : 0;
}

/**
 * 上报文本区尺寸（cols/rows）给 kernel 的假终端。
 * textWidth/textHeight 是**文本区客户区**尺寸（不含标题栏）：文本区左边有内边距，
 * 可用列宽要再减去 BODY_PAD_X——这与鼠标换算（cellAt）用的是同一个原点。
 * 唯一入口：cols/rows 非正（非有限值、不足一格）一律不发——
 * 历史上踩过 NaN 直接透传到 kernel 的坑，终端 resize 会拿到非法列行。
 */
export function reportTuiSize(
	sessionId: string,
	panelId: string,
	textWidth: number,
	textHeight: number,
	cellWidth = CELL.width,
): void {
	const cols = colsFromWidth(textWidth - BODY_PAD_X, cellWidth);
	const rows = rowsFromHeight(textHeight);
	if (cols < 1 || rows < 1) return;
	void api
		.post("/api/extensions/tui-input", {
			sessionId,
			panelId,
			type: "resize",
			cols,
			rows,
		})
		.catch(() => {});
}

/**
 * widget 宽度上报（列数）：pi 的 setWidget 按列数排版，宽度不对正文会错乱换行。
 * panelId 用 `w:<widgetKey>`（kernel 侧的 widget panel id，规格 §6.4）；
 * widget 只吃列数，行数无关，故这里只发 cols。
 *
 * 用兜底常量而不是面板的实测格宽：widget dock 是另一处布局（字号跟 `--font-scale`），
 * 要准就得在它自己那儿量——超出本次范围，属已知局限。
 */
export function reportWidgetCols(
	sessionId: string,
	widgetKey: string,
	width: number,
): void {
	const cols = colsFromWidth(width);
	if (cols < 1) return;
	void api
		.post("/api/extensions/tui-input", {
			sessionId,
			panelId: `w:${widgetKey}`,
			type: "resize",
			cols,
		})
		.catch(() => {});
}

/** 视口尺寸：无布局宿主（组件测试的 happy-dom）与容器量不到时的兜底基准 */
function viewportSize(): Size {
	return {
		width: Number.isFinite(window.innerWidth) ? window.innerWidth : 0,
		height: Number.isFinite(window.innerHeight) ? window.innerHeight : 0,
	};
}

/**
 * 读定位上下文的尺寸。面板是 absolute，坐标系是**最近的定位祖先**：聊天列容器
 * （SessionView 里那个 relative 的 div），clamp 与默认位置都必须以它为基准。
 * 历史缺陷（用户实测）：以 window 为基准，于是挂件贴到了**整个窗口**的右上角。
 *
 * 首选 offsetParent（浏览器里就是那个定位祖先）；无布局宿主（happy-dom 的 offsetParent
 * 是 undefined）退回 parentElement。量不到正数宽高（尚未挂载、display:none）再退回视口，
 * 保证无布局宿主仍可运行。
 */
function locateSize(el: HTMLElement | null): Size {
	const box = (el?.offsetParent ?? el?.parentElement)?.getBoundingClientRect();
	if (box && box.width > 0 && box.height > 0) {
		return { width: box.width, height: box.height };
	}
	return viewportSize();
}

/** 数值 clamp：夹到 [0, max]，非有限值当 0（历史 NaN 透传的坑），max 为负时取 0 */
function clampNum(v: number, max: number): number {
	return Math.max(0, Math.min(Math.max(0, max), Number.isFinite(v) ? v : 0));
}

/** 浮窗位置尺寸 clamp：不小于最小尺寸，整体留在定位上下文内 */
function clampPanelRect(r: PanelRect, size: Size): PanelRect {
	const vw = Math.max(0, size.width);
	const vh = Math.max(0, size.height);
	const w = Math.max(
		MIN_SIZE.width,
		Math.min(Math.max(vw, MIN_SIZE.width), r.w),
	);
	const h = Math.max(
		MIN_SIZE.height,
		Math.min(Math.max(vh, MIN_SIZE.height), r.h),
	);
	return { w, h, x: clampNum(r.x, vw - w), y: clampNum(r.y, vh - h) };
}

/**
 * 收起态（挂件/胶囊）位置 clamp：x 按**挂件自身宽度**限制，不能用展开态的 rect.w。
 *
 * 历史缺陷（用户实测「只能停在一个固定位置、拖不动了」）：收起态复用展开矩形的 x、又按
 * 680 宽 clamp，渲染时还按 `right = 容器宽 − (x + 680)` 定位，于是实际左缘 = x + 412，
 * 可达区间被压成 [412, 898]——左侧 412px 永远拖不到。左缘锚定 + 按自身宽 clamp 之后，
 * x ∈ [0, 容器宽 − 挂件宽]，能一直拖到容器左上角。
 *
 * height 是收起态元素的实测高（胶囊固定 32、挂件随预览行数变）；量不到（无布局宿主）传 0，
 * 那就只限制在容器上界内——宁可宽松，也不能拿错的高度把挂件夹在半空。
 */
function clampCollapsedPos(p: PanelPos, size: Size, height = 0): PanelPos {
	const vw = Math.max(0, size.width);
	const vh = Math.max(0, size.height);
	return {
		x: clampNum(p.x, vw - BADGE_WIDTH),
		y: clampNum(p.y, vh - Math.max(0, height)),
	};
}

/** 默认位置：定位上下文（聊天列）右上角 */
function defaultPanelRect(size: Size): PanelRect {
	const w = Math.min(
		EXPANDED_SIZE.width,
		Math.max(MIN_SIZE.width, size.width - 32),
	);
	const h = Math.min(
		EXPANDED_SIZE.height,
		Math.max(MIN_SIZE.height, size.height - 32),
	);
	return clampPanelRect({ x: size.width - w - 16, y: 16, w, h }, size);
}

/**
 * 收起态默认位置：定位上下文（聊天列）右上角，按**挂件自身宽度**算偏移。
 * 胶囊复用同一份默认位置（见 PanelPos 注释），两者切态不会跳位。
 */
function defaultCollapsedPos(size: Size): PanelPos {
	return clampCollapsedPos({ x: size.width - BADGE_WIDTH - 16, y: 16 }, size);
}

/** 读回上次的位置尺寸；无记录/形状非法返回 null（调用方按当前尺寸算默认值） */
function readSavedRect(): PanelRect | null {
	try {
		const v = JSON.parse(localStorage.getItem(LS_RECT) ?? "");
		if (
			v &&
			[v.x, v.y, v.w, v.h].every(
				(n) => typeof n === "number" && Number.isFinite(n),
			)
		) {
			return v;
		}
	} catch {
		/* 解析失败用默认 */
	}
	return null;
}

/** 位置尺寸：用户拖过的用持久化值，否则按给定尺寸算默认右上角 */
function loadPanelRect(size: Size): PanelRect {
	const saved = readSavedRect();
	return saved ? clampPanelRect(saved, size) : defaultPanelRect(size);
}

/**
 * 读回收起态位置；无记录/形状非法返回 null（调用方按当前尺寸算默认值，
 * 历史数据里可能只有 {x} 或少字段，不能当有效位置用）。
 */
function readSavedPos(): PanelPos | null {
	try {
		const v = JSON.parse(localStorage.getItem(LS_COLLAPSED) ?? "");
		if (
			v &&
			[v.x, v.y].every((n) => typeof n === "number" && Number.isFinite(n))
		) {
			return { x: v.x, y: v.y };
		}
	} catch {
		/* 解析失败用默认 */
	}
	return null;
}

/**
 * 收起态位置：用户拖过的用持久化值（按挂件宽 clamp 回容器内），
 * 否则按容器尺寸算默认右上角。
 */
function loadCollapsedPos(size: Size): PanelPos {
	const saved = readSavedPos();
	return saved ? clampCollapsedPos(saved, size) : defaultCollapsedPos(size);
}

function samePos(a: PanelPos, b: PanelPos): boolean {
	return a.x === b.x && a.y === b.y;
}

function saveCollapsedPos(p: PanelPos): void {
	try {
		localStorage.setItem(LS_COLLAPSED, JSON.stringify(p));
	} catch {
		/* 存储不可用（隐私模式等）忽略：位置记忆非关键路径 */
	}
}

function sameRect(a: PanelRect, b: PanelRect): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function savePanelRect(r: PanelRect): void {
	try {
		localStorage.setItem(LS_RECT, JSON.stringify(r));
	} catch {
		/* 存储不可用（隐私模式等）忽略：位置记忆非关键路径 */
	}
}

/** OSC 8 开 / 闭标记：`ESC ] 8 ; params ; url BEL|ST`（与 lib/tui-ansi 的 OSC_RE 同语义） */
const OSC8_RE = /\u001b\]8;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

/**
 * 按 OSC 8 链接把一行切成段：带 url 的段渲染成锚点，其余交给 AnsiText。
 *
 * 为什么不用 lib/tui-ansi 的 takeLinks：它只给「文本 + url」清单，不带行内偏移，
 * 无法把链接放回原位置（一段帧行里链接前后还有普通文本与颜色段）。
 */
export function splitOsc8(text: string): Array<{ text: string; url?: string }> {
	if (!text.includes("\u001b]8;")) return [{ text }];
	const segments: Array<{ text: string; url?: string }> = [];
	let url: string | undefined;
	let last = 0;
	for (const m of text.matchAll(OSC8_RE)) {
		if (m.index === undefined) continue;
		if (m.index > last) {
			const chunk = text.slice(last, m.index);
			segments.push(url ? { text: chunk, url } : { text: chunk });
		}
		// m[1] 是 `params;url`（开标记 url 非空；闭标记为空 → 关闭链接）
		const target = (m[1] ?? "").split(";").slice(1).join(";");
		url = target || undefined;
		last = m.index + m[0].length;
	}
	if (last < text.length) {
		const chunk = text.slice(last);
		segments.push(url ? { text: chunk, url } : { text: chunk });
	}
	return segments;
}

/**
 * 一行帧：OSC 8 链接渲染为 `<a target="_blank" rel="noreferrer">`，
 * 由 Electron 侧的 setWindowOpenHandler 转成应用内新窗口（无需新增 IPC）。
 * 帧的 ANSI 属性必须渲染（AnsiText 默认 attrs=false 只为守历史契约）。
 *
 * `cellWidth` 传给 AnsiText 后，全角字符按 2 格宽渲染（实测格宽是唯一基准，
 * 与尺寸上报/鼠标命中同一份，见 CELL 常量处的注释）；不传则保持原样（挂件缩略图不需要）。
 */
function FrameLine({ text, cellWidth }: { text: string; cellWidth?: number }) {
	const segments = splitOsc8(text);
	if (segments.length === 1 && !segments[0].url) {
		return <AnsiText text={segments[0].text} cellWidth={cellWidth} />;
	}
	return (
		<>
			{segments.map((seg, i) =>
				seg.url ? (
					<a
						key={i}
						href={seg.url}
						target="_blank"
						rel="noreferrer"
						/* 挂件态整体是可点展开区：链点不要顺带把面板展开 */
						onClick={(e) => e.stopPropagation()}
						/* 链接色走主题 accent（与 markdown 链接同一口径），不再写死暗色蓝 */
						className="text-accent underline"
					>
						<AnsiText text={seg.text} cellWidth={cellWidth} />
					</a>
				) : (
					<AnsiText key={i} text={seg.text} cellWidth={cellWidth} />
				),
			)}
		</>
	);
}

/** 像素偏移 → 终端 1-based 下标；非有限值兜底为 1（不让 NaN 变成序列） */
function axisIndex(offset: number, cell: number): number {
	if (!Number.isFinite(offset)) return 1;
	return Math.max(1, Math.floor(offset / cell) + 1);
}

/**
 * 实测一格宽度（px）：面板内那个隐藏等宽探针 span 的实宽 ÷ 探针字符数。
 *
 * 返回 null 时调用方回退到 `CELL.width`：无布局的宿主（组件测试的 happy-dom）量到 0，
 * `font-display: swap` 的字体尚未就绪时也可能偏小——宁可退到常量，也不能拿 0/NaN 换算列行。
 */
function measureCellWidth(probe: HTMLElement | null): number | null {
	if (!probe) return null;
	const chars = probe.textContent?.length ?? 0;
	if (chars < 1) return null;
	const cell = probe.getBoundingClientRect().width / chars;
	return Number.isFinite(cell) && cell > 1 ? cell : null;
}

export function TuiPanel({ sessionId }: { sessionId: string | null }) {
	const { t } = useTranslation();
	const panel = useTuiPanelStore((s) =>
		sessionId ? s.bySession[sessionId] : undefined,
	);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const probeRef = useRef<HTMLSpanElement | null>(null);
	/**
	 * 实测格宽：ref 供一切「像素 ↔ 列」换算同步读取（尺寸上报、鼠标命中、光标），
	 * state 只用于触发重渲染（渲染期要用它画光标方块与全角格宽）。两者必须同时更新。
	 */
	const cellRef = useRef(CELL.width);
	const [cellWidth, setCellWidth] = useState(CELL.width);
	// 首帧还没有 DOM 引用，只能按视口读回持久化值占位；挂载后由 useLayoutEffect
	// 用真实容器尺寸重算（见下），所以这里传视口尺寸不影响最终结果。
	// 展开态与收起态各一份位置：宽度不同，共享 x 在左缘锚定下贴不住右缘。
	const [rect, setRect] = useState<PanelRect>(() =>
		loadPanelRect(viewportSize()),
	);
	const [pos, setPos] = useState<PanelPos>(() =>
		loadCollapsedPos(viewportSize()),
	);
	/**
	 * 定位上下文尺寸：三态都是左缘锚定（不再在渲染期换算右缘偏移），但它仍要参与
	 * clamp 与默认位置换算，所以要有 state；ref 供拖动期同步读取。
	 */
	const [ctxSize, setCtxSize] = useState<Size>(viewportSize);
	const ctxSizeRef = useRef<Size>(viewportSize());
	// 拖动/缩放会话：mousedown 起、窗口级监听、mouseup 一次性提交（阈值 5px）
	const dragRef = useRef<{
		kind: "move" | "resize";
		/** 拖动作用在哪个位置：收起态（挂件/胶囊）改 pos，展开态改 rect，两者互不影响 */
		collapsed: boolean;
		startX: number;
		startY: number;
		/** 基准位置：展开态取 rect.x/y，收起态取（已 clamp 的）pos */
		base: PanelPos;
		/** 基准宽高：只有展开态会改（缩放） */
		w: number;
		h: number;
		/** 收起态底边 clamp 用的元素实测高（0 = 量不到，只限制在容器上界内） */
		height: number;
		moved: boolean;
		/** 拖动中的最新位置：收起态写 last，展开态写 lastRect，mouseup 各取各的提交 */
		last?: PanelPos;
		lastRect?: PanelRect;
	} | null>(null);
	/**
	 * 拖动结束的那次 mouseup，浏览器还会补一个 click：用它把「拖动」与「点击」分开
	 * （挂件/胶囊的点击语义是展开，拖动过就不能再顺带展开）。
	 */
	const dragClickRef = useRef(false);
	// 鼠标上报的左键按下态：决定松开时要不要补一个 up（点击语义）
	const pressRef = useRef<{ button: number } | null>(null);

	// 用户是否主动滚离帧底部（onScroll 维护）：决定帧刷新时要不要自动贴底
	const userScrolledAwayRef = useRef(false);

	// 帧刷新自动贴底：帧尾是对话框的选项/确认区（决策面），正文一长选项就被推出
	// 浮窗首屏（pi 侧行数钳制按创建时的终端行数算定，浮窗拖小后帧仍可能高于视口）。
	// 用户未上滚时跟随帧尾保证选项始终可见；上滚阅读正文则不打扰，滚回底部附近
	// 自动恢复跟随（isScrolledAwayFromBottom 判定）。
	useEffect(() => {
		if (userScrolledAwayRef.current) return;
		const el = bodyRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [panel?.lines]);

	/**
	 * 输入上报统一出口：panelId 从 store 现取（帧流会持续重渲染，
	 * 用渲染期快照会拿到旧 panelId）。失败静默——面板掉线不该弹错。
	 */
	const post = useCallback(
		(payload: Record<string, unknown>) => {
			const cur = sessionId
				? useTuiPanelStore.getState().bySession[sessionId]
				: undefined;
			if (!sessionId || !cur) return;
			void api
				.post("/api/extensions/tui-input", {
					sessionId,
					panelId: cur.panelId,
					...payload,
				})
				.catch(() => {});
		},
		[sessionId],
	);

	/**
	 * 上报展开态文本区尺寸（cols/rows）。
	 * 基准必须是**文本区**（bodyRef）而不是容器（boxRef）：容器含标题栏，
	 * 按容器换算会多报标题栏那 1 行、左内边距那 2 列，帧的右缘与末行会被 overflow-hidden 裁掉。
	 * 鼠标换算（cellAt）也以文本区为原点，两者必须同源。
	 */
	const reportPanelSize = useCallback(() => {
		if (!sessionId) return;
		const el = bodyRef.current;
		if (!el) return;
		const cur = useTuiPanelStore.getState().bySession[sessionId];
		if (!cur) return;
		const { width, height } = el.getBoundingClientRect();
		reportTuiSize(sessionId, cur.panelId, width, height, cellRef.current);
	}, [sessionId]);

	/**
	 * 把键盘焦点收回面板容器。
	 * mousedown 的 preventDefault 会吃掉浏览器「把焦点给可聚焦祖先」的默认动作，
	 * 不显式还回来，用户点过别处（Composer/侧栏）再点回面板时焦点回不来，
	 * 而 Composer 已 disabled——面板看着是活的却在静默丢键。
	 */
	const focusPanel = useCallback(() => {
		boxRef.current?.focus({ preventScroll: true });
	}, []);

	/**
	 * 会话切换补发（规格 §5.4）：kernel 里面板可能是在本前端没订阅时开的，
	 * 切过去先拉一次快照铺回面板与最后一帧。
	 *
	 * 「请求失败」与「该会话没有面板」必须区分：失败什么也不做（保留在显示的面板），
	 * 成功才交给 store 判定（空快照 = 断开期间面板已关 → 清陈旧状态）。
	 */
	useEffect(() => {
		if (!sessionId) return;
		let cancelled = false;
		const before =
			useTuiPanelStore.getState().bySession[sessionId]?.panelId ?? null;
		void api
			.get(
				`/api/extensions/tui-snapshot?sessionId=${encodeURIComponent(sessionId)}`,
			)
			.then((body) => {
				if (cancelled) return;
				// 请求在途时面板变了（SSE open 与慢到的快照竞态）：保留新面板，
				// 否则一个「旧时刻」的空快照会把刚推来的面板清掉
				const now =
					useTuiPanelStore.getState().bySession[sessionId]?.panelId ?? null;
				if (now !== before) return;
				useTuiPanelStore
					.getState()
					.restoreFrom(sessionId, body as ExtensionTuiSnapshotResult);
			})
			.catch(() => {
				/* 请求失败（网络/kernel 重启中）：保持现状，绝不当成「无面板」处理 */
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	/**
	 * 挂载/切态后用**真实容器尺寸**重算位置：首帧没有 DOM 引用（useState 初值只能按
	 * 视口占位，见上），这里才真正落到聊天列坐标系。用户拖过的位置尊重持久化值、只做边界
	 * clamp；从未拖过的按容器尺寸重算默认右上角——否则「容器宽 − 面板宽 − 16」那 16px
	 * 边距会被 clamp 吃掉（视口默认值比容器默认值靠右，只会被夹到贴边）。
	 * 展开态与收起态各算各的：宽度不同，clamp 上限也不同。
	 */
	useLayoutEffect(() => {
		if (!panel) return;
		const size = locateSize(boxRef.current);
		ctxSizeRef.current = size;
		setCtxSize(size);
		const savedRect = readSavedRect();
		setRect((r) => {
			const next = savedRect
				? clampPanelRect(savedRect, size)
				: defaultPanelRect(size);
			return sameRect(next, r) ? r : next;
		});
		const savedPos = readSavedPos();
		setPos((p) => {
			const next = savedPos
				? clampCollapsedPos(savedPos, size)
				: defaultCollapsedPos(size);
			return samePos(next, p) ? p : next;
		});
	}, [panel?.panelId, panel?.mode]);

	// 展开态：接管键盘焦点 + 按文本区（不含标题栏）实际宽高上报终端列行
	useEffect(() => {
		if (panel?.mode !== "expanded" || !sessionId) return;
		boxRef.current?.focus();
		reportPanelSize();
	}, [panel?.mode, panel?.panelId, sessionId, reportPanelSize]);

	/**
	 * 实测一格宽度（规格 §7.2 的「用等宽字体保证全角占两格」需要以真实度量为基准）。
	 *
	 * 用 layout effect：它在同一次提交里先于下面的尺寸上报 effect 跑，把 ref 换成实测值，
	 * 上报就不会先发一版硬编码列数再补一版（重渲染只用于重画光标/全角格宽）。
	 * 字体是本地 woff2 + `font-display: swap`：首帧可能还没换上，所以 `document.fonts.ready`
	 * 后再量一次（量不到/量到同一个值就什么也不做）。
	 */
	useLayoutEffect(() => {
		if (panel?.mode !== "expanded") return;
		let stopped = false;
		const measure = () => {
			if (stopped) return;
			const width = measureCellWidth(probeRef.current);
			if (width === null || width === cellRef.current) return;
			cellRef.current = width;
			setCellWidth(width);
		};
		measure();
		void document.fonts?.ready.then(measure).catch(() => {});
		return () => {
			stopped = true;
		};
	}, [panel?.mode, panel?.panelId]);

	// 鼠标左键在面板外松开时复位按下态并补一个 up（否则回到面板会把上一次的 down 与
	// 新一次的点按混成一次点击）
	useEffect(() => {
		const onUp = (e: MouseEvent) => {
			const pressed = pressRef.current;
			if (!pressed) return;
			pressRef.current = null;
			const el = bodyRef.current;
			if (!el) return;
			const box = el.getBoundingClientRect();
			post({
				type: "mouse",
				data: encodeMouse(
					"up",
					pressed.button,
					axisIndex(e.clientX - box.left - BODY_PAD_X, cellRef.current),
					axisIndex(e.clientY - box.top, CELL.height),
				),
			});
		};
		window.addEventListener("mouseup", onUp);
		return () => window.removeEventListener("mouseup", onUp);
	}, [post]);

	// === 浮窗拖动 / 缩放（与 FloatBubble 同套路：直接改 DOM，mouseup 提交一次）===

	/**
	 * 拖动期的直接 DOM 写入（每帧 setState 太重）。三态一律左缘锚定，只写 left/top
	 * （展开态另写 width/height），**不写 right**——右缘锚定会让位置随自身宽度漂移。
	 * 只写当前态本来就由 React 渲染的属性，避免与 React 的 style diff 脱节。
	 */
	const applyDragPos = useCallback(
		(p: PanelPos, size?: { w: number; h: number }) => {
			const el = boxRef.current;
			if (!el) return;
			el.style.left = `${p.x}px`;
			el.style.top = `${p.y}px`;
			if (!size) return;
			el.style.width = `${size.w}px`;
			el.style.height = `${size.h}px`;
		},
		[],
	);

	const onWindowMouseMove = useCallback(
		(e: MouseEvent) => {
			const d = dragRef.current;
			if (!d) return;
			const dx = e.clientX - d.startX;
			const dy = e.clientY - d.startY;
			if (!d.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
			d.moved = true;
			// 收起态：只改自己的位置，按挂件宽（而不是展开态 680）clamp
			if (d.collapsed) {
				const next = clampCollapsedPos(
					{ x: d.base.x + dx, y: d.base.y + dy },
					ctxSizeRef.current,
					d.height,
				);
				d.last = next;
				applyDragPos(next);
				return;
			}
			const next = clampPanelRect(
				d.kind === "move"
					? { x: d.base.x + dx, y: d.base.y + dy, w: d.w, h: d.h }
					: { x: d.base.x, y: d.base.y, w: d.w + dx, h: d.h + dy },
				ctxSizeRef.current,
			);
			d.lastRect = next;
			applyDragPos(next, { w: next.w, h: next.h });
		},
		[applyDragPos],
	);

	const onWindowMouseUp = useCallback(() => {
		const d = dragRef.current;
		if (!d) return;
		dragRef.current = null;
		document.body.style.userSelect = "";
		window.removeEventListener("mousemove", onWindowMouseMove);
		window.removeEventListener("mouseup", onWindowMouseUp);
		if (!d.moved) return; // 未拖动 = 点击，交给按钮自身的 click
		dragClickRef.current = true; // mouseup 之后补的那个 click 要吃掉
		// 收起态与展开态各提交各的位置（互不覆写）
		if (d.collapsed) {
			if (!d.last) return;
			setPos(d.last);
			saveCollapsedPos(d.last);
			return;
		}
		if (!d.lastRect) return;
		setRect(d.lastRect);
		savePanelRect(d.lastRect);
		// 尺寸变了要告诉终端重新排版（读 applyDragPos 后的文本区 rect）；只移动位置则不必
		if (d.kind === "resize") reportPanelSize();
	}, [onWindowMouseMove, reportPanelSize]);

	/**
	 * 开始拖动/缩放。`collapsed` 决定改哪一份位置：挂件/胶囊传 true（改 pos），
	 * 展开态标题栏与缩放手柄传 false（改 rect）。
	 */
	const beginDrag = useCallback(
		(kind: "move" | "resize", e: ReactMouseEvent, collapsed = false) => {
			e.preventDefault();
			// preventDefault 也会吃掉默认聚焦：显式收回焦点，否则拖动后键盘锁静默失效
			focusPanel();
			dragClickRef.current = false; // 新一次按下作废上一次的「拖动过」
			// 收起态底边限制用元素实测高；量不到（无布局宿主）当 0，只限制在容器上界内
			const measured = boxRef.current?.getBoundingClientRect().height ?? 0;
			const height = collapsed && Number.isFinite(measured) ? measured : 0;
			dragRef.current = {
				kind,
				collapsed,
				startX: e.clientX,
				startY: e.clientY,
				// 收起态的基准取**渲染用的**（已 clamp 的）位置：容器刚变窄时状态值可能越界，
				// 直接从越界值起拖会先跳一下
				base: collapsed ? clampCollapsedPos(pos, ctxSizeRef.current, height) : rect,
				w: rect.w,
				h: rect.h,
				height,
				moved: false,
			};
			document.body.style.userSelect = "none";
			window.addEventListener("mousemove", onWindowMouseMove);
			window.addEventListener("mouseup", onWindowMouseUp);
		},
		[rect, pos, focusPanel, onWindowMouseMove, onWindowMouseUp],
	);

	/** 返回 true = 这次点击是拖动后浏览器补的，调用方应忽略它（拖动 ≠ 点击） */
	const isDragClick = useCallback(() => {
		if (!dragClickRef.current) return false;
		dragClickRef.current = false;
		return true;
	}, []);

	// === 鼠标 / 键盘 / 粘贴上报 ===

	const cellAt = (el: HTMLElement, clientX: number, clientY: number) => {
		const box = el.getBoundingClientRect();
		return {
			col: axisIndex(clientX - box.left - BODY_PAD_X, cellRef.current),
			row: axisIndex(clientY - box.top, CELL.height),
		};
	};

	/**
	 * 面板 body 的鼠标按下。
	 *
	 * **刻意不 preventDefault**：面板帧就是普通 DOM 文本，浏览器原生选择 + Cmd+C 是复制路径
	 * （规格 §7.5：`copySelection` 的宿主钩子被「浏览器原生选择」替代——OSC 52 兜底会经
	 * `stripOsc` 与假 Terminal 的 `write()` 被丢掉，拖拽转发若还 preventDefault，两条复制路径
	 * 就都不通）。同理不再上报 `drag` 序列（`encodeMouse("drag", …)`）：TUI 收到 drag 会走它
	 * 自己的选择逻辑并打断原生选字。点击要用的 down/up 与滚轮仍照发——TUI 的选择/滚动靠它们。
	 */
	const onBodyMouseDown = (e: ReactMouseEvent) => {
		// 焦点仍要显式收回：拖动把手等处会 preventDefault，这里保持一致，避免点过别处后面板丢键
		focusPanel();
		pressRef.current = { button: e.button };
		const { col, row } = cellAt(
			e.currentTarget as HTMLElement,
			e.clientX,
			e.clientY,
		);
		post({ type: "mouse", data: encodeMouse("down", e.button, col, row) });
	};

	const onKeyDown = (e: ReactKeyboardEvent) => {
		// encodeKey 返回 null = 该键放行给浏览器（Cmd 组合、不认识的功能键）
		const seq = encodeKey(e);
		if (seq === null) return;
		e.preventDefault();
		post({ type: "key", data: seq });
	};

	const onPaste = (e: ReactClipboardEvent) => {
		const text = e.clipboardData?.getData("text") ?? "";
		if (!text) return;
		e.preventDefault();
		post({ type: "paste", data: encodePaste(text) });
	};

	if (!sessionId || !panel) return null;

	const store = useTuiPanelStore.getState();
	const pendingBadge =
		panel.pending > 1 ? (
			<span
				data-testid="tui-panel-pending"
				title={t("tuiPanel.pending")}
				className="rounded-pill bg-surface-elevated px-1.5 text-[10px] text-tertiary"
			>
				+{panel.pending - 1}
			</span>
		) : null;

	// 展开态：右上角浮窗（可拖拽移动、右下拉大拉小、键盘与鼠标锁给面板）
	if (panel.mode === "expanded") {
		return (
			<div
				ref={boxRef}
				data-testid="tui-panel-expanded"
				tabIndex={0}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				/* bg-canvas：终端内容底色取主题最底层的画布色；描边与仓库其他浮层同口径 */
				className="absolute z-50 flex flex-col overflow-hidden rounded-[10px] border border-hairline bg-canvas font-mono shadow-2xl outline-none"
				style={{
					left: rect.x,
					top: rect.y,
					width: rect.w,
					height: rect.h,
				}}
			>
				{/*
				 * 量宽探针：与帧文本同字体同字号（font-mono 从容器继承 + 12px），
				 * 绝对定位 + visibility: hidden（display:none 会没有布局，量不到宽度）。
				 */}
				<span
					ref={probeRef}
					data-testid="tui-panel-metric"
					aria-hidden="true"
					className="pointer-events-none absolute left-0 top-0 whitespace-pre text-[12px]"
					style={{ visibility: "hidden" }}
				>
					{"M".repeat(METRIC_PROBE_CHARS)}
				</span>
				{/* 标题栏：拖动把手 + 标题 + 排队角标 + 「—」收起 + 「✕」取消 */}
				<div
					data-testid="tui-panel-header"
					onMouseDown={(e) => {
						// 标题栏按钮的点击不当作拖动（否则拖动会吃掉按钮的 click）
						if ((e.target as HTMLElement).closest("button")) return;
						beginDrag("move", e);
					}}
					className="flex shrink-0 cursor-move items-center gap-2 bg-surface-elevated px-2.5 py-1.5"
				>
					<span className="mr-auto truncate text-[11px] text-secondary">
						{panel.title}
					</span>
					{pendingBadge}
					<button
						type="button"
						title={t("tuiPanel.collapse")}
						onClick={() => store.collapse(sessionId)}
						className="h-[18px] w-[18px] rounded-sm border-0 bg-transparent text-[12px] leading-none text-secondary hover:bg-surface-hover"
					>
						—
					</button>
					<button
						type="button"
						title={t("tuiPanel.cancel")}
						onClick={() => post({ type: "cancel" })}
						className="h-[18px] w-[18px] rounded-sm border-0 bg-transparent text-[12px] leading-none text-secondary hover:bg-surface-hover"
					>
						✕
					</button>
				</div>
				{/* 帧网格：逐行渲染、行高锁 CELL.height 保列对齐；光标按 (row,col) 叠加方块 */}
				<div
					ref={bodyRef}
					data-testid="tui-panel-body"
					// 纵向必须可滚：pi 侧取的是整帧快照（不按可视行数裁剪），长面板
					// （如 pi-goal-x 的提案全文 40+ 行）此前被 overflow-hidden 静默裁掉，
					// 用户既看不到也滚不到。横向仍裁，否则长行会把列对齐撑破。
					className="relative flex-1 overflow-y-auto overflow-x-hidden text-[12px] text-primary"
					// user-select: text：面板文本要能选中复制（祖先若设了 user-select: none，这里覆盖回来）
					// 这里的 text-primary 只是**默认**文字色：帧里 ANSI 显式前景色由 AnsiText 内联样式覆盖
					style={{ userSelect: "text" }}
					onMouseDown={onBodyMouseDown}
					onScroll={() => {
						const el = bodyRef.current;
						if (!el) return;
						userScrolledAwayRef.current = isScrolledAwayFromBottom(
							el.scrollTop,
							el.clientHeight,
							el.scrollHeight,
							CELL.height,
						);
					}}
					// 滚轮不再转发给插件，改为滚动本容器：插件视口的变化不会体现在整帧快照里，
					// 转发等于「滚了没反应」；点击与拖拽仍照旧转发（插件的鼠标选择交互）。
					onContextMenu={(e) => e.preventDefault()}
				>
					{panel.lines.map((line, i) => (
						<div
							key={i}
							className="whitespace-pre"
							style={{
								height: CELL.height,
								lineHeight: `${CELL.height}px`,
								paddingLeft: BODY_PAD_X,
							}}
						>
							<FrameLine text={line} cellWidth={cellWidth} />
						</div>
					))}
					{panel.cursor && (
						<div
							data-testid="tui-panel-cursor"
							className="pointer-events-none absolute"
							style={{
								left: BODY_PAD_X + panel.cursor.col * cellWidth,
								top: panel.cursor.row * CELL.height,
								width: cellWidth,
								height: CELL.height,
								/* 反色方块：颜色取主题的主文字色（亮/暗主题各自反色），
								   保留原来的 .75 半透明——mix-blend-difference 下的反色强度靠它，
								   降到完全不透明会在亮色主题里变成一块刺眼的实心反色 */
								background: "var(--text-primary)",
								opacity: 0.75,
								mixBlendMode: "difference",
							}}
						/>
					)}
				</div>
				{/* 右下角缩放手柄（nwse-resize） */}
				<div
					data-testid="tui-panel-resize"
					onMouseDown={(e) => beginDrag("resize", e)}
					className="absolute bottom-0 right-0 h-3.5 w-3.5"
					style={{ cursor: "nwse-resize" }}
				/>
			</div>
		);
	}

	// 收起态（挂件/胶囊）共用的位置：渲染期按当前容器尺寸再夹一次。
	// 容器变窄（开文件树/预览）后 state 里的位置会瞬时越界，不夹挂件会被推到列外看不见
	// （等下次拖动/切态才重新 clamp）。
	const collapsedPos = clampCollapsedPos(pos, ctxSize);

	// 挂件态：右上角预览卡片（实时帧缩略 + 点开 + 再深一层收成胶囊）
	if (panel.mode === "badge") {
		return (
			<div
				ref={boxRef}
				data-testid="tui-panel-badge"
				title={t("tuiPanel.expand")}
				onMouseDown={(e) => {
					// 卡片里的按钮照旧可点；其余区域按下即开始拖动（阈值 5px）
					if ((e.target as HTMLElement).closest("button")) return;
					beginDrag("move", e, true);
				}}
				onClick={() => {
					// 拖动过的那次 click 要吃掉，否则一拖就展开
					if (isDragClick()) return;
					store.expand(sessionId);
				}}
				className="absolute z-50 cursor-pointer overflow-hidden rounded-[10px] bg-surface-elevated shadow-xl"
				style={{
					/* 左缘锚定：left 就是左缘相对容器的偏移，位置与自身宽度解耦。
					   旧实现按 right = 容器宽 − (x + 展开宽 680) 定位，于是实际左缘 = x + 412，
					   左侧 412px 永远拖不到（用户实测的「只能停在一个固定位置」） */
					left: collapsedPos.x,
					top: collapsedPos.y,
					width: BADGE_WIDTH,
				}}
			>
				<div className="flex items-center gap-1.5 px-2 py-1.5">
					<span className="mr-auto truncate font-mono text-[10.5px] text-secondary">
						{panel.title}
					</span>
					{pendingBadge}
					<button
						type="button"
						title={t("tuiPanel.collapseDeeper")}
						onClick={(e) => {
							e.stopPropagation();
							store.collapseDeeper(sessionId);
						}}
						className="h-[16px] w-[16px] rounded-sm border-0 bg-transparent text-[11px] leading-none text-secondary hover:bg-surface-hover"
					>
						–
					</button>
				</div>
				<div className="whitespace-pre bg-canvas px-2.5 py-2 font-mono text-[9.5px] leading-[1.66] text-primary">
					{panel.lines.slice(0, BADGE_PREVIEW_LINES).map((line, i) => (
						<div key={i}>
							<FrameLine text={line} />
						</div>
					))}
				</div>
			</div>
		);
	}

	// 胶囊态：最小挂件（可拖；与挂件共享同一份收起态位置，与展开态互不影响）
	return (
		<div
			ref={boxRef}
			onMouseDown={(e) => beginDrag("move", e, true)}
			className="absolute z-50 flex h-8 items-center gap-2 rounded-pill bg-surface-elevated pl-3 pr-2 shadow-lg"
			style={{
				left: collapsedPos.x, // 同上：左缘锚定，容器变窄时由 collapsedPos 夹在列内
				top: collapsedPos.y,
			}}
		>
			<button
				type="button"
				data-testid="tui-panel-pill"
				title={t("tuiPanel.expand")}
				onClick={() => {
					if (isDragClick()) return;
					store.expand(sessionId);
				}}
				className="max-w-[220px] truncate border-0 bg-transparent font-mono text-[11.5px] text-primary"
			>
				{panel.title}
			</button>
			<button
				type="button"
				title={t("tuiPanel.cancel")}
				onClick={() => {
					// 胶囊整块是拖动区（标题按钮占了大半），拖动过就别当真取消
					if (isDragClick()) return;
					post({ type: "cancel" });
				}}
				className="h-[18px] w-[18px] rounded-sm border-0 bg-transparent text-[12px] leading-none text-secondary hover:bg-surface-hover"
			>
				✕
			</button>
		</div>
	);
}
