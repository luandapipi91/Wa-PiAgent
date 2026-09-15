// 扩展 TUI 面板（ctx.ui.custom 兼容）在界面上的三态浮窗：
//   expanded —— 展开态：标题栏可拖动、右下角可缩放、键盘/鼠标锁给面板；
//   badge    —— 挂件态：右上角预览卡片（实时帧缩略），点主体展开；
//   pill     —— 胶囊态：最小挂件，只剩标题 + 取消。
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
	type WheelEvent as ReactWheelEvent,
} from "react";
import type { ExtensionTuiSnapshotResult } from "@wa-pi/shared";
import { useTuiPanelStore } from "../store/tui-panel";
import { useTranslation } from "../i18n/useTranslation";
import { api } from "../api-client";
import { encodeKey, encodeMouse, encodePaste, encodeWheel } from "../lib/tui-keys";
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
/** 拖动与点击的位移阈值（px，与 FloatBubble 同口径） */
const DRAG_THRESHOLD = 5;
/** 浮窗位置尺寸的持久化键（窗口级，不按会话区分：位置是用户对浮窗的偏好） */
const LS_RECT = "hiagent.tuiPanel.rect";

interface PanelRect {
	x: number;
	y: number;
	w: number;
	h: number;
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
export function reportWidgetCols(sessionId: string, widgetKey: string, width: number): void {
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

/** 浮窗位置尺寸 clamp：不小于最小尺寸，整体留在视口内 */
function clampPanelRect(r: PanelRect): PanelRect {
	const vw = Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
	const vh = Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
	const w = Math.max(MIN_SIZE.width, Math.min(Math.max(vw, MIN_SIZE.width), r.w));
	const h = Math.max(MIN_SIZE.height, Math.min(Math.max(vh, MIN_SIZE.height), r.h));
	const cl = (v: number, max: number) =>
		Math.max(0, Math.min(Math.max(0, max), Number.isFinite(v) ? v : 0));
	return { w, h, x: cl(r.x, vw - w), y: cl(r.y, vh - h) };
}

/** 默认位置：主内容区右上角（与挂件态同锚点） */
function defaultPanelRect(): PanelRect {
	const w = Math.min(
		EXPANDED_SIZE.width,
		Math.max(MIN_SIZE.width, window.innerWidth - 32),
	);
	const h = Math.min(
		EXPANDED_SIZE.height,
		Math.max(MIN_SIZE.height, window.innerHeight - 32),
	);
	return clampPanelRect({ x: window.innerWidth - w - 16, y: 16, w, h });
}

/** 读回上次的位置尺寸；无记录/形状非法用默认值 */
function loadPanelRect(): PanelRect {
	try {
		const v = JSON.parse(localStorage.getItem(LS_RECT) ?? "");
		if (
			v &&
			[v.x, v.y, v.w, v.h].every(
				(n) => typeof n === "number" && Number.isFinite(n),
			)
		) {
			return clampPanelRect(v);
		}
	} catch {
		/* 解析失败用默认 */
	}
	return defaultPanelRect();
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
						className="underline"
						style={{ color: "#60a5fa" }}
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
	const [rect, setRect] = useState<PanelRect>(() => loadPanelRect());
	// 拖动/缩放会话：mousedown 起、窗口级监听、mouseup 一次性提交（阈值 5px）
	const dragRef = useRef<{
		kind: "move" | "resize";
		startX: number;
		startY: number;
		base: PanelRect;
		moved: boolean;
		last?: PanelRect;
	} | null>(null);
	// 鼠标上报的左键按下态：决定松开时要不要补一个 up（点击语义）
	const pressRef = useRef<{ button: number } | null>(null);

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
			.get(`/api/extensions/tui-snapshot?sessionId=${encodeURIComponent(sessionId)}`)
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

	const applyRect = useCallback((r: PanelRect) => {
		const el = boxRef.current;
		if (!el) return;
		el.style.left = `${r.x}px`;
		el.style.top = `${r.y}px`;
		el.style.width = `${r.w}px`;
		el.style.height = `${r.h}px`;
	}, []);

	const onWindowMouseMove = useCallback(
		(e: MouseEvent) => {
			const d = dragRef.current;
			if (!d) return;
			const dx = e.clientX - d.startX;
			const dy = e.clientY - d.startY;
			if (!d.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
			d.moved = true;
			const next = clampPanelRect(
				d.kind === "move"
					? { ...d.base, x: d.base.x + dx, y: d.base.y + dy }
					: { ...d.base, w: d.base.w + dx, h: d.base.h + dy },
			);
			d.last = next;
			applyRect(next);
		},
		[applyRect],
	);

	const onWindowMouseUp = useCallback(() => {
		const d = dragRef.current;
		if (!d) return;
		dragRef.current = null;
		document.body.style.userSelect = "";
		window.removeEventListener("mousemove", onWindowMouseMove);
		window.removeEventListener("mouseup", onWindowMouseUp);
		if (!d.moved || !d.last) return; // 未拖动 = 点击，交给按钮自身的 click
		setRect(d.last);
		savePanelRect(d.last);
		// 尺寸变了要告诉终端重新排版（读 applyRect 后的文本区 rect）；只移动位置则不必
		if (d.kind === "resize") reportPanelSize();
	}, [onWindowMouseMove, reportPanelSize]);

	const beginDrag = useCallback(
		(kind: "move" | "resize", e: ReactMouseEvent) => {
			e.preventDefault();
			// preventDefault 也会吃掉默认聚焦：显式收回焦点，否则拖动后键盘锁静默失效
			focusPanel();
			dragRef.current = {
				kind,
				startX: e.clientX,
				startY: e.clientY,
				base: rect,
				moved: false,
			};
			document.body.style.userSelect = "none";
			window.addEventListener("mousemove", onWindowMouseMove);
			window.addEventListener("mouseup", onWindowMouseUp);
		},
		[rect, focusPanel, onWindowMouseMove, onWindowMouseUp],
	);

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
		const { col, row } = cellAt(e.currentTarget as HTMLElement, e.clientX, e.clientY);
		post({ type: "mouse", data: encodeMouse("down", e.button, col, row) });
	};

	const onBodyWheel = (e: ReactWheelEvent) => {
		const { col, row } = cellAt(e.currentTarget as HTMLElement, e.clientX, e.clientY);
		post({
			type: "mouse",
			data: encodeWheel(e.deltaY < 0 ? "up" : "down", col, row),
		});
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
				className="fixed z-50 flex flex-col overflow-hidden rounded-[10px] font-mono shadow-2xl outline-none"
				style={{
					left: rect.x,
					top: rect.y,
					width: rect.w,
					height: rect.h,
					background: "#101014",
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
					className="flex shrink-0 cursor-move items-center gap-2 px-2.5 py-1.5"
					style={{ background: "#1a1a21" }}
				>
					<span
						className="mr-auto truncate text-[11px]"
						style={{ color: "#8b8b9a" }}
					>
						{panel.title}
					</span>
					{pendingBadge}
					<button
						type="button"
						title={t("tuiPanel.collapse")}
						onClick={() => store.collapse(sessionId)}
						className="h-[18px] w-[18px] rounded-sm border-0 bg-transparent text-[12px] leading-none hover:bg-surface-hover"
						style={{ color: "#8b8b9a" }}
					>
						—
					</button>
					<button
						type="button"
						title={t("tuiPanel.cancel")}
						onClick={() => post({ type: "cancel" })}
						className="h-[18px] w-[18px] rounded-sm border-0 bg-transparent text-[12px] leading-none hover:bg-surface-hover"
						style={{ color: "#8b8b9a" }}
					>
						✕
					</button>
				</div>
				{/* 帧网格：逐行渲染、行高锁 CELL.height 保列对齐；光标按 (row,col) 叠加方块 */}
				<div
					ref={bodyRef}
					data-testid="tui-panel-body"
					className="relative flex-1 overflow-hidden text-[12px]"
					// user-select: text：面板文本要能选中复制（祖先若设了 user-select: none，这里覆盖回来）
					style={{ color: "#d2d2de", userSelect: "text" }}
					onMouseDown={onBodyMouseDown}
					onWheel={onBodyWheel}
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
								background: "rgba(210,210,222,.75)",
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

	// 挂件态：右上角预览卡片（实时帧缩略 + 点开 + 再深一层收成胶囊）
	if (panel.mode === "badge") {
		return (
			<div
				data-testid="tui-panel-badge"
				title={t("tuiPanel.expand")}
				onClick={() => store.expand(sessionId)}
				className="fixed z-50 cursor-pointer overflow-hidden rounded-[10px] shadow-xl"
				style={{ right: 16, top: 16, width: 268, background: "#1a1a21" }}
			>
				<div className="flex items-center gap-1.5 px-2 py-1.5">
					<span
						className="mr-auto truncate font-mono text-[10.5px]"
						style={{ color: "#8b8b9a" }}
					>
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
						className="h-[16px] w-[16px] rounded-sm border-0 bg-transparent text-[11px] leading-none hover:bg-surface-hover"
						style={{ color: "#8b8b9a" }}
					>
						–
					</button>
				</div>
				<div
					className="whitespace-pre px-2.5 py-2 font-mono text-[9.5px] leading-[1.66]"
					style={{ background: "#101014", color: "#d2d2de" }}
				>
					{panel.lines.slice(0, BADGE_PREVIEW_LINES).map((line, i) => (
						<div key={i}>
							<FrameLine text={line} />
						</div>
					))}
				</div>
			</div>
		);
	}

	// 胶囊态：最小挂件
	return (
		<div
			className="fixed z-50 flex h-8 items-center gap-2 rounded-pill pl-3 pr-2 shadow-lg"
			style={{ right: 16, top: 16, background: "#1a1a21" }}
		>
			<button
				type="button"
				data-testid="tui-panel-pill"
				title={t("tuiPanel.expand")}
				onClick={() => store.expand(sessionId)}
				className="max-w-[220px] truncate border-0 bg-transparent font-mono text-[11.5px]"
				style={{ color: "#d2d2de" }}
			>
				{panel.title}
			</button>
			<button
				type="button"
				title={t("tuiPanel.cancel")}
				onClick={() => post({ type: "cancel" })}
				className="h-[18px] w-[18px] rounded-sm border-0 bg-transparent text-[12px] leading-none hover:bg-surface-hover"
				style={{ color: "#8b8b9a" }}
			>
				✕
			</button>
		</div>
	);
}
