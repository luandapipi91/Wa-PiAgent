/**
 * 图片标注画布：图片 + 底部半透明浮条（工具 / 粗细 / 颜色 / 撤销 / 清空 / 折叠 / 取消 / 保存）。
 *
 * - 坐标一律存图片自然像素；`canvas.width/height` = 图片自然尺寸，CSS 按容器 contain 缩放，
 *   指针坐标乘 `canvas.width / rect.width` 换算。
 * - 浮条 absolute 悬浮、不占布局，可折叠为 32×32 小笔按钮。
 * - 标注只在前端内存：保存时经 `renderAnnotatedBlob` 合成进像素交给 `onSave`。
 * - 撤销是操作栈（add / erase / clear），橡皮擦与清空都可回退，历史上限 200 步。
 */
import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	type Ref,
} from "react";
import { useTranslation } from "../../../i18n/useTranslation";
import { Icon, type IconName } from "../../ui/Icon";
import {
	ANNOTATOR_COLORS,
	drawShapes,
	hitTestShape,
	normalizeRect,
	renderAnnotatedBlob,
	strokeWidthFor,
	undoAction,
} from "./draw";
import { clampPan, type ImageTransform } from "../ZoomableImage";
import type {
	AnnotatorAction,
	Point,
	Shape,
	StrokeLevel,
	Tool,
} from "./types";

const TOOLS: { tool: Tool; icon: IconName; labelKey: string }[] = [
	// 现有图标库没有专门的箭头/方形/椭圆/文字/橡皮，取最接近的图形（不使用 emoji）
	{ tool: "hand", icon: "hand", labelKey: "blocks.imageAnnotator.toolHand" },
	{ tool: "arrow", icon: "arrow-up", labelKey: "blocks.imageAnnotator.toolArrow" },
	{ tool: "rect", icon: "checkbox", labelKey: "blocks.imageAnnotator.toolRect" },
	{ tool: "ellipse", icon: "circle", labelKey: "blocks.imageAnnotator.toolEllipse" },
	{ tool: "text", icon: "note", labelKey: "blocks.imageAnnotator.toolText" },
	{ tool: "pen", icon: "edit", labelKey: "blocks.imageAnnotator.toolPen" },
	{ tool: "eraser", icon: "trash", labelKey: "blocks.imageAnnotator.toolEraser" },
];

const WIDTHS: { level: StrokeLevel; dot: number; labelKey: string }[] = [
	{ level: "thin", dot: 4, labelKey: "blocks.imageAnnotator.thin" },
	{ level: "medium", dot: 6, labelKey: "blocks.imageAnnotator.medium" },
	{ level: "thick", dot: 9, labelKey: "blocks.imageAnnotator.thick" },
];

/** 历史栈上限：超出只丢最早的历史，可见 shapes 不受影响 */
const HISTORY_LIMIT = 200;

/** 可标注图片尺寸上限（规格 §3.1 条件 4）：边长 ≤ 8192 且总像素 ≤ 40MP（40,000,000 像素，十进制口径）。
 *  超限图片进标注会吃掉大量内存，在加载阶段直接拒绝。 */
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;

/** 文字输入浮层尺寸：宽度走内联样式保证与夹取计算一致；高度取保守估计（略大于实际行高） */
const TEXT_INPUT_WIDTH = 112;
const TEXT_INPUT_HEIGHT = 28;

/** 把浮层偏移夹取到容器内；容器尺寸不可测（0/undefined）时原样返回 */
function clampOffset(
	offset: number,
	containerSize: number | undefined,
	size: number,
): number {
	if (!containerSize) return offset;
	return Math.min(Math.max(offset, 0), Math.max(0, containerSize - size));
}

/** 玻璃质感：半透明 + 背景模糊，下层图片始终透出 */
const BAR_STYLE = {
	background: "color-mix(in srgb, var(--surface) 78%, transparent)",
	backdropFilter: "blur(10px)",
	border: "1px solid color-mix(in srgb, var(--hairline) 70%, transparent)",
	boxShadow: "0 6px 20px rgba(0, 0, 0, 0.18)",
} as const;

const TOOL_BTN =
	"flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors";
const ACTION_BTN =
	"flex h-7 shrink-0 items-center justify-center rounded-full px-1.5 text-[calc(12px*var(--font-scale))] text-secondary transition-colors hover:text-primary disabled:cursor-default disabled:opacity-40";

/** 空拖拽判定：矩形/椭圆两个方向都要够 2px，箭头/画笔按位移长度 */
function isMeaningfulShape(shape: Shape): boolean {
	if (shape.kind === "rect" || shape.kind === "ellipse") {
		return shape.w >= 2 && shape.h >= 2;
	}
	if (shape.kind === "arrow") {
		return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) >= 2;
	}
	if (shape.kind === "stroke") {
		const [first] = shape.points;
		if (!first) return false;
		return shape.points.some(
			(p) => Math.abs(p.x - first.x) >= 2 || Math.abs(p.y - first.y) >= 2,
		);
	}
	return shape.text.trim().length > 0;
}

/** 把拖拽当前位置应用到进行中的 shape（pointermove 与 pointerup 共用，避免漏掉末点） */
function extendShape(shape: Shape, point: Point, anchor: Point | null): Shape {
	if (shape.kind === "stroke") {
		const last = shape.points[shape.points.length - 1];
		// 采样点间距 > 1px，避免同点堆积
		if (last && Math.hypot(point.x - last.x, point.y - last.y) <= 1) {
			return shape;
		}
		return { ...shape, points: [...shape.points, point] };
	}
	if (shape.kind === "arrow") return { ...shape, x2: point.x, y2: point.y };
	if (shape.kind === "rect" || shape.kind === "ellipse") {
		if (!anchor) return shape;
		return { ...shape, ...normalizeRect(anchor.x, anchor.y, point.x, point.y) };
	}
	return shape;
}

/** 缩放范围（与 ZoomableImage 一致） */
const clampZoom = (z: number) => Math.max(0.1, Math.min(20, z));

/** requestCancel 的结果：exited=已直接退出（无图形）；confirming=弹出了丢弃确认；
 *  refused=保存中，拒绝退出（调用方不应记关窗意图） */
export type AnnotatorCancelResult = "exited" | "confirming" | "refused";

export type AnnotatorHandle = {
	/** 请标注组件尝试退出：无图形直接回调 onCancel，有图形先弹丢弃确认；保存中直接拒绝 */
	requestCancel: () => AnnotatorCancelResult;
	/** 顶栏缩放控件（标注态下显示）：与滚轮/双击共用同一套 zoom */
	zoomIn: () => void;
	zoomOut: () => void;
	resetZoom: () => void;
};

export function ImageAnnotator({
	src,
	alt,
	mime,
	onCancel,
	onSave,
	onExportError,
	apiRef,
	onDiscardCancelled,
	initialZoom,
	initialPan,
	onZoomChange,
	onTransformChange,
}: {
	src: string;
	alt: string;
	mime: string;
	onCancel: (dirty: boolean) => void;
	onSave: (blob: Blob) => Promise<void>;
	/** 导出（原图 + 标注合成成 Blob）失败：父组件负责提示，避免用户无限重试而无反馈 */
	onExportError?: () => void;
	/** 对外开放「尝试退出」（父组件顶栏 ✕ 等外部关闭入口用） */
	apiRef?: Ref<AnnotatorHandle>;
	/** 丢弃确认里选了「取消」：撤销父组件在请求退出时记下的关闭意图 */
	onDiscardCancelled?: () => void;
	/** 初始缩放/平移：从预览态进来时沿用用户已经调好的视角，不重置回 100% */
	initialZoom?: number;
	initialPan?: { x: number; y: number };
	/** 缩放值上报（顶栏百分比） */
	onZoomChange?: (zoom: number) => void;
	/** 缩放/平移变化上报（父组件存起来，退出编辑后交回预览） */
	onTransformChange?: (t: ImageTransform) => void;
}) {
	const { t } = useTranslation();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	// 矩形/椭圆的拖拽锚点（draft 的 x/y 会被归一化覆盖，锚点单独存）
	const anchorRef = useRef<Point | null>(null);

	const [image, setImage] = useState<HTMLImageElement | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	// 尺寸/像素超限：进标注会吃掉大量内存，展示错误态而不是画布（规格 §3.1 条件 4）
	const [tooLarge, setTooLarge] = useState(false);
	const [tool, setTool] = useState<Tool>("pen");
	const [color, setColor] = useState<string>(ANNOTATOR_COLORS[0]);
	const [level, setLevel] = useState<StrokeLevel>("medium");
	const [shapes, setShapes] = useState<Shape[]>([]);
	const [history, setHistory] = useState<AnnotatorAction[]>([]);
	const [draft, setDraft] = useState<Shape | null>(null);
	// 缩放/平移：与预览态同一套语义（transform-origin center + translate/scale），
	// 绘制坐标经 getBoundingClientRect 自动吃到变换，换算公式不需要改。
	const [zoom, setZoom] = useState(() => clampZoom(initialZoom ?? 1));
	const [pan, setPan] = useState(initialPan ?? { x: 0, y: 0 });
	// 空格键按住 = 临时抓手：绘制工具与平移手势共存，不需要切工具
	const [spaceHeld, setSpaceHeld] = useState(false);
	// 正在拖拽平移：只用于光标反馈（panDragRef 是 ref，变化不触发重渲染）
	const [panning, setPanning] = useState(false);
	const panDragRef = useRef<{
		startX: number;
		startY: number;
		panX: number;
		panY: number;
	} | null>(null);
	const [textDraft, setTextDraft] = useState<{
		x: number;
		y: number;
		left: number;
		top: number;
		value: string;
	} | null>(null);
	const [confirm, setConfirm] = useState<"clear" | "discard" | null>(null);
	const [saving, setSaving] = useState(false);

	const strokeWidth = image
		? strokeWidthFor(image.naturalWidth, image.naturalHeight, level)
		: 2;

	// 图片加载：happy-dom 无解码能力，测试注入 Image 打桩
	useEffect(() => {
		setImage(null);
		setLoadFailed(false);
		setTooLarge(false);
		const img = new Image();
		img.onload = () => {
			if (
				img.naturalWidth > MAX_IMAGE_SIDE ||
				img.naturalHeight > MAX_IMAGE_SIDE ||
				img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS
			) {
				setTooLarge(true);
				return;
			}
			setImage(img);
		};
		img.onerror = () => setLoadFailed(true);
		img.src = src;
		return () => {
			img.onload = null;
			img.onerror = null;
		};
	}, [src]);

	// 每次 image / shapes / draft 变化全量重绘：先铺原图，再按序画标注。
	// 原图必须画进 canvas（而不是叠一个 <img>）：导出用的是同一套绘制，显示与导出一致；
	// 漏画原图时画布只剩标注线，用户看到的就是「图片不见了」。
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		drawShapes(ctx, draft ? [...shapes, draft] : shapes);
	}, [image, shapes, draft]);

	const remember = useCallback((action: AnnotatorAction) => {		setHistory((prev) => {
			const next = [...prev, action];
			return next.length > HISTORY_LIMIT
				? next.slice(next.length - HISTORY_LIMIT)
				: next;
		});
	}, []);

	/** 指针坐标 → 图片自然像素 */
	const toNatural = useCallback(
		(e: React.PointerEvent<HTMLCanvasElement>): Point | null => {
			const canvas = canvasRef.current;
			if (!canvas) return null;
			// getBoundingClientRect 返回的是**变换后**的矩形，所以缩放下 canvas.width/rect.width
			// 自动包含 zoom，缩放后的坐标换算不需要另写一套公式
			const rect = canvas.getBoundingClientRect();
			if (!rect.width || !rect.height) return null;
			const scale = canvas.width / rect.width;
			return {
				x: (e.clientX - rect.left) * scale,
				y: (e.clientY - rect.top) * scale,
			};
		},
		[],
	);

	// 缩放/平移上报：顶栏百分比 + 父组件存视角（退出编辑后交回预览，不跳回 100%）
	useEffect(() => {
		onZoomChange?.(zoom);
	}, [zoom, onZoomChange]);
	useEffect(() => {
		onTransformChange?.({ zoom, pan });
	}, [zoom, pan, onTransformChange]);

	// 滚轮缩放：绑在根容器（画布与四周留白都能缩放），手动绑定以关闭 passive 才能 preventDefault
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			setZoom((z) => clampZoom(z + delta * z));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	// 空格键 = 临时抓手：绘制工具与平移手势共存，不靠切工具
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.code !== "Space" || textDraft) return;
			e.preventDefault();
			setSpaceHeld(true);
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.code === "Space") setSpaceHeld(false);
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
		};
	}, [textDraft]);

	const resetZoom = useCallback(() => {
		setZoom(1);
		setPan({ x: 0, y: 0 });
	}, []);
	const zoomIn = useCallback(() => setZoom((z) => clampZoom(z * 1.25)), []);
	const zoomOut = useCallback(() => setZoom((z) => clampZoom(z / 1.25)), []);

	/** 平移：只在「图片将被完全拖出视口」时才夹取，任何缩放比例（含 <100%）都可自由拖 */
	const applyPan = useCallback((next: { x: number; y: number }) => {
		const canvas = canvasRef.current;
		const root = rootRef.current;
		if (!canvas || !root) return setPan(next);
		// offsetWidth/Height 不受 transform 影响，就是 contain 后的基准尺寸与视口尺寸
		setPan(
			clampPan(
				next,
				zoom,
				canvas.offsetWidth,
				canvas.offsetHeight,
				root.offsetWidth,
				root.offsetHeight,
			),
		);
	}, [zoom]);

	/** 开始平移：记起点与当前偏移（canvas 与手掌层共用） */
	const beginPan = useCallback(
		(clientX: number, clientY: number) => {
			panDragRef.current = {
				startX: clientX,
				startY: clientY,
				panX: pan.x,
				panY: pan.y,
			};
			setPanning(true);
		},
		[pan],
	);
	/** 拖拽中：累加位移后夹取（只保「图片没被整张拖出视口」） */
	const movePan = useCallback(
		(clientX: number, clientY: number) => {
			const drag = panDragRef.current;
			if (!drag) return;
			applyPan({
				x: drag.panX + (clientX - drag.startX),
				y: drag.panY + (clientY - drag.startY),
			});
		},
		[applyPan],
	);
	const endPan = useCallback(() => {
		panDragRef.current = null;
		setPanning(false);
	}, []);

	const addShape = useCallback(
		(shape: Shape) => {
			setShapes((prev) => [...prev, shape]);
			remember({ type: "add", shape });
		},
		[remember],
	);

	// 橡皮擦：命中即删除最上层（数组末尾）的一个，一次事件只删一个
	const eraseAt = useCallback(
		(point: Point) => {
			for (let i = shapes.length - 1; i >= 0; i -= 1) {
				if (!hitTestShape(shapes[i], point)) continue;
				remember({ type: "erase", shape: shapes[i], index: i });
				setShapes([...shapes.slice(0, i), ...shapes.slice(i + 1)]);
				return;
			}
		},
		[shapes, remember],
	);

	const undo = useCallback(() => {
		const action = history[history.length - 1];
		if (!action) return;
		setShapes((prev) => undoAction(prev, action));
		// 只 pop 一次：undoAction 依赖 shape 引用同一性，重复 pop 会连撤两步
		setHistory((prev) => prev.slice(0, -1));
	}, [history]);

	const requestCancel = useCallback((): AnnotatorCancelResult => {
		if (saving) return "refused";
		if (shapes.length > 0) {
			setConfirm("discard");
			return "confirming";
		}
		onCancel(false);
		return "exited";
	}, [saving, shapes.length, onCancel]);

	useImperativeHandle(
		apiRef,
		() => ({ requestCancel, zoomIn, zoomOut, resetZoom }),
		[requestCancel, zoomIn, zoomOut, resetZoom],
	);

	/** 关掉确认条；丢弃确认被取消时通知父组件撤销关闭意图 */
	const dismissConfirm = useCallback(() => {
		if (confirm === "discard") onDiscardCancelled?.();
		setConfirm(null);
	}, [confirm, onDiscardCancelled]);

	// Esc 与 Ctrl/Cmd+Z：标注态内全局生效（文字输入框自行拦截）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				undo();
				return;
			}
			if (e.key !== "Escape" || textDraft) return;
			e.preventDefault();
			// 确认条打开时，Esc 先关确认条，不直接触发退出
			if (confirm) dismissConfirm();
			else requestCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [undo, requestCancel, dismissConfirm, textDraft, confirm]);

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (saving) return;
		// 中键 / 空格+左键 / 手掌工具 = 平移（不产生图形）：左键仍归绘制，不能无条件抢
		if (e.button === 1 || (e.button === 0 && (spaceHeld || tool === "hand"))) {
			e.preventDefault();
			e.currentTarget.setPointerCapture?.(e.pointerId);
			beginPan(e.clientX, e.clientY);
			return;
		}
		if (e.button !== 0) return;
		const point = toNatural(e);
		if (!point) return;

		if (tool === "text") {
			// input 的包含块是根容器（canvas 在 contain 布局下可能居中留白），
			// 所以偏移要相对根容器算；用 canvas rect 会在留白区明显错位
			const rootRect = rootRef.current?.getBoundingClientRect();
			const canvasRect = e.currentTarget.getBoundingClientRect();
			const offsetX = rootRect
				? e.clientX - rootRect.left
				: e.clientX - canvasRect.left;
			const offsetY = rootRect
				? e.clientY - rootRect.top
				: e.clientY - canvasRect.top;
			setTextDraft({
				x: point.x,
				y: point.y,
				// 靠右/靠下点击时夹取到容器内，避免输入框溢出被裁掉
				left: clampOffset(offsetX, rootRect?.width, TEXT_INPUT_WIDTH),
				top: clampOffset(offsetY, rootRect?.height, TEXT_INPUT_HEIGHT),
				value: "",
			});
			return;
		}

		e.currentTarget.setPointerCapture?.(e.pointerId);
		if (tool === "eraser") {
			eraseAt(point);
			return;
		}

		anchorRef.current = point;
		if (tool === "pen") {
			setDraft({ kind: "stroke", points: [point], color, width: strokeWidth });
		} else if (tool === "arrow") {
			setDraft({
				kind: "arrow",
				x1: point.x,
				y1: point.y,
				x2: point.x,
				y2: point.y,
				color,
				width: strokeWidth,
			});
		} else if (tool === "rect" || tool === "ellipse") {
			setDraft({
				kind: tool,
				x: point.x,
				y: point.y,
				w: 0,
				h: 0,
				color,
				width: strokeWidth,
			});
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (saving) return;
		// 平移中：只动视角，不碰草稿
		if (panDragRef.current) {
			movePan(e.clientX, e.clientY);
			return;
		}
		const point = toNatural(e);
		if (!point) return;

		if (tool === "eraser") {
			if (e.buttons !== 0) eraseAt(point);
			return;
		}

		setDraft((prev) => (prev ? extendShape(prev, point, anchorRef.current) : prev));
	};

	/** 指针被系统取消（手势被接管 / 触控中断）：丢弃草稿，不把半截图当成用户画的图形 */
	const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = e.currentTarget;
		if (canvas.hasPointerCapture?.(e.pointerId)) {
			canvas.releasePointerCapture?.(e.pointerId);
		}
		panDragRef.current = null;
		endPan();
		anchorRef.current = null;
		setDraft(null);
	};

	const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = e.currentTarget;
		if (canvas.hasPointerCapture?.(e.pointerId)) {
			canvas.releasePointerCapture?.(e.pointerId);
		}
		// 平移结束：不提交任何图形
		if (panDragRef.current) {
			endPan();
			return;
		}
		const anchor = anchorRef.current;
		anchorRef.current = null;
		if (!draft) return;
		// pointerup 坐标也要并入，避免最后一帧 move 丢失导致形状偏小
		const point = toNatural(e);
		const shape = point ? extendShape(draft, point, anchor) : draft;
		setDraft(null);
		if (!isMeaningfulShape(shape)) return;
		addShape(shape);
	};

	const submitText = () => {
		if (!textDraft) return;
		const { x, y, value } = textDraft;
		setTextDraft(null);
		const text = value.trim();
		if (!text) return;
		addShape({
			kind: "text",
			x,
			y,
			text,
			color,
			fontSize: Math.max(14, strokeWidth * 5),
		});
	};

	const doClear = () => {
		if (shapes.length === 0) return;
		remember({ type: "clear", shapes });
		setShapes([]);
		setConfirm(null);
	};

	const save = async () => {
		if (!image || saving || shapes.length === 0) return;
		setSaving(true);
		let blob: Blob;
		// 只包导出：导出失败时父组件的 onSave 根本不会被调用，必须单独回调 onExportError 才有提示
		try {
			blob = await renderAnnotatedBlob(
				image,
				image.naturalWidth,
				image.naturalHeight,
				shapes,
				mime,
			);
		} catch {
			setSaving(false);
			onExportError?.();
			return;
		}
		try {
			await onSave(blob);
		} catch {
			// 保存失败提示由父组件负责（这里不重复 toast）；保留编辑态与全部 shapes 供重试
		} finally {
			setSaving(false);
		}
	};

	const divider = (
		<span className="mx-0.5 h-5 w-px shrink-0 bg-hairline" aria-hidden="true" />
	);

	return (
		<div
			ref={rootRef}
			data-testid="image-annotator"
			className="relative flex flex-1 min-h-0 items-center justify-center overflow-hidden"
		>
			{loadFailed ? (
				<div className="text-[calc(12px*var(--font-scale))] text-tertiary">
					{t("blocks.imageAnnotator.loadFailed")}
				</div>
			) : tooLarge ? (
				<div
					data-testid="annotator-too-large"
					className="flex flex-col items-center gap-2 text-[calc(12px*var(--font-scale))] text-tertiary"
				>
					<span>{t("blocks.imageAnnotator.tooLarge")}</span>
					<button
						type="button"
						data-testid="annotator-too-large-cancel"
						onClick={() => onCancel(false)}
						className="rounded-full bg-surface-hover px-2.5 py-1 text-[calc(12px*var(--font-scale))] text-secondary"
					>
						{t("blocks.imageAnnotator.cancel")}
					</button>
				</div>
			) : (
				<canvas
					ref={canvasRef}
					data-testid="annotator-canvas"
					aria-label={alt}
					width={image?.naturalWidth ?? 0}
					height={image?.naturalHeight ?? 0}
					// 缩放/平移与预览态同一套 transform（origin center），指针换算仍由 rect 自动吃变换
					style={{
						transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
						transformOrigin: "center center",
						// 手掌工具或空格按住时是抓手（可拖图），其余工具是十字准星
						cursor:
							tool === "hand" || spaceHeld
								? panning
									? "grabbing"
									: "grab"
								: "crosshair",
						willChange: "transform",
					}}
					className="block max-h-full max-w-full touch-none"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerCancel}
					onDoubleClick={resetZoom}
				/>
			)}

			{/* 文字工具的内联输入框：位置取 pointerdown 时的容器内偏移 */}
			{/* 手掌/空格模式：整块编辑区（含图片四周留白）都能拖，不必正好按在图片上。
			只有在这些模式下才铺这层，绘制工具下它不拦截事件。 */}
			{(tool === "hand" || spaceHeld) && !loadFailed && !tooLarge && (
				<div
					data-testid="annotator-pan-layer"
					className="absolute inset-0 z-[1] touch-none"
					style={{ cursor: panning ? "grabbing" : "grab" }}
					onPointerDown={(e) => {
						if (e.button !== 0 && e.button !== 1) return;
						e.preventDefault();
						e.currentTarget.setPointerCapture?.(e.pointerId);
						beginPan(e.clientX, e.clientY);
					}}
					onPointerMove={(e) => movePan(e.clientX, e.clientY)}
					onPointerUp={(e) => {
						if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
							e.currentTarget.releasePointerCapture?.(e.pointerId);
						}
						endPan();
					}}
					onPointerCancel={(e) => {
						if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
							e.currentTarget.releasePointerCapture?.(e.pointerId);
						}
						endPan();
					}}
				/>
			)}

			{textDraft && (
				<input
					data-testid="annotator-text-input"
					autoFocus
					value={textDraft.value}
					style={{
						left: textDraft.left,
						top: textDraft.top,
						width: TEXT_INPUT_WIDTH,
						color,
					}}
					className="absolute z-20 rounded-sm border border-hairline bg-surface px-1 py-0.5 text-[calc(13px*var(--font-scale))] outline-none"
					onChange={(e) =>
						setTextDraft((prev) =>
							prev ? { ...prev, value: e.target.value } : prev,
						)
					}
					onKeyDown={(e) => {
						// 输入框内的 Esc/Enter 不外泄到浮条快捷键
						e.stopPropagation();
						// 输入法组词中（拼音选词等）的 Enter 是确认候选词，不是提交文字
						if (e.nativeEvent.isComposing || e.keyCode === 229) return;
						if (e.key === "Enter") submitText();
						else if (e.key === "Escape") setTextDraft(null);
					}}
				/>
			)}

			{/* 浮条：尺寸超限时没有可编辑图片，不渲染 */}
			{!tooLarge && (
				<div
					data-testid="annotator-bar"
					role="toolbar"
					aria-label={t("blocks.imageAnnotator.annotate")}
					className="absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-full px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					style={BAR_STYLE}
				>
					{confirm ? (
						<div
							data-testid="annotator-confirm"
							className="flex items-center gap-2 whitespace-nowrap px-1"
						>
							<span className="text-[calc(12px*var(--font-scale))] text-secondary">
								{confirm === "clear"
									? t("blocks.imageAnnotator.clearConfirm")
									: t("blocks.imageAnnotator.discardConfirm")}
							</span>
							<button
								type="button"
								data-testid="annotator-confirm-yes"
								onClick={confirm === "clear" ? doClear : () => onCancel(true)}
								className="rounded-full bg-brand px-2 py-1 text-[calc(12px*var(--font-scale))] text-white"
							>
								{t("blocks.imageAnnotator.confirmYes")}
							</button>
							<button
								type="button"
								data-testid="annotator-confirm-no"
								onClick={dismissConfirm}
								className="rounded-full bg-surface-hover px-2 py-1 text-[calc(12px*var(--font-scale))] text-secondary"
							>
								{t("blocks.imageAnnotator.confirmNo")}
							</button>
						</div>
					) : (
						<>
							<div data-testid="annotator-tools" className="flex items-center">
								{TOOLS.map((item) => (
									<button
										key={item.tool}
										type="button"
										data-testid={`annotator-tool-${item.tool}`}
										aria-label={t(item.labelKey)}
										aria-pressed={tool === item.tool}
										// 再点一次已选中的工具 = 取消选中回到手掌（默认笔选中，再点笔就是拖图）
										title={t(item.labelKey)}
										onClick={() =>
											setTool((prev) => (prev === item.tool ? "hand" : item.tool))
										}
										className={`${TOOL_BTN} ${
											tool === item.tool
												? "bg-surface-hover text-primary"
												: "text-secondary hover:text-primary"
										}`}
									>
										<Icon name={item.icon} size={15} />
									</button>
								))}
							</div>
							{divider}
							<div
								data-testid="annotator-widths"
								className="flex items-center"
								role="group"
							>
								{WIDTHS.map((item) => (
									<button
										key={item.level}
										type="button"
										data-testid={`annotator-width-${item.level}`}
										aria-label={t(item.labelKey)}
										aria-pressed={level === item.level}
										title={t(item.labelKey)}
										onClick={() => setLevel(item.level)}
										className={`${TOOL_BTN} ${
											level === item.level
												? "text-primary"
												: "text-tertiary hover:text-secondary"
										}`}
									>
										<span
											className="rounded-full bg-current"
											style={{ width: item.dot, height: item.dot }}
										/>
									</button>
								))}
							</div>
							{divider}
							<div
								data-testid="annotator-colors"
								className="flex items-center"
								aria-label={t("blocks.imageAnnotator.colorLabel")}
								role="group"
							>
								{ANNOTATOR_COLORS.map((value) => (
									<button
										key={value}
										type="button"
										data-testid={`annotator-color-${value.slice(1)}`}
										aria-label={value}
										aria-pressed={color === value}
										onClick={() => setColor(value)}
										className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
									>
										<span
											className="rounded-full"
											style={{
												background: value,
												width: color === value ? 16 : 12,
												height: color === value ? 16 : 12,
												boxShadow:
													color === value
														? `0 0 0 1.5px var(--surface), 0 0 0 2.5px ${value}`
														: "none",
											}}
										/>
									</button>
								))}
							</div>
							{divider}
							<button
								type="button"
								data-testid="annotator-undo"
								aria-label={t("blocks.imageAnnotator.undo")}
								title={t("blocks.imageAnnotator.undo")}
								onClick={undo}
								disabled={history.length === 0}
								className={ACTION_BTN}
							>
								<Icon name="reply" size={15} />
							</button>
							<button
								type="button"
								data-testid="annotator-clear"
								aria-label={t("blocks.imageAnnotator.clear")}
								title={t("blocks.imageAnnotator.clear")}
								onClick={() => setConfirm("clear")}
								disabled={shapes.length === 0}
								className={ACTION_BTN}
							>
								<Icon name="trash" size={15} />
							</button>
							{divider}
							<button
								type="button"
								data-testid="annotator-cancel"
								onClick={requestCancel}
								disabled={saving}
								className={ACTION_BTN}
							>
								{t("blocks.imageAnnotator.cancel")}
							</button>
							<button
								type="button"
								data-testid="annotator-save"
								onClick={save}
								disabled={saving || !image || shapes.length === 0}
								className="ml-0.5 flex h-7 shrink-0 items-center rounded-full bg-brand px-2.5 text-[calc(12px*var(--font-scale))] text-white transition-opacity disabled:cursor-default disabled:opacity-50"
							>
								{saving
									? t("blocks.imageAnnotator.saving")
									: t("blocks.imageAnnotator.save")}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
