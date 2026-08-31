import { useCallback, useRef, useState } from "react";
import { clampRect, type FloatRect } from "../store/browser";

interface Props {
	rect: FloatRect;
	/** 拖拽结束（mouseup）时一次性回调最终 rect（store 侧 clamp + 持久化） */
	onRectChange: (r: FloatRect) => void;
	/** 最小化/恢复动画期间的覆盖样式（合并到根样式之后；此时内部拖拽不应生效） */
	animStyle?: React.CSSProperties;
	children: React.ReactNode;
}

/** mousedown 命中这些交互元素时不触发拖动（按钮/输入等保持原行为） */
const INTERACTIVE_SELECTOR =
	'button, input, a, select, textarea, [contenteditable], [role="textbox"]';

/**
 * 浮动预览窗（无标题栏）：工具栏等非交互区域按住即拖动位置，右下角手柄拖尺寸。
 * 性能与可靠性要点：
 * - 拖拽中直接改 DOM style（不经 React 渲染），mouseup 才一次性提交 store——跟手不卡顿；
 * - 拖拽中内容区 pointer-events:none，防止鼠标划入 iframe 后事件被吞
 *   （父文档收不到 mousemove/mouseup 会卡死并泄漏监听器）。
 */
export function FloatWindow({ rect, onRectChange, animStyle, children }: Props) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const drag = useRef<{
		kind: "move" | "resize";
		startX: number;
		startY: number;
		base: FloatRect;
		last: FloatRect;
	} | null>(null);
	const [dragging, setDragging] = useState(false);

	const applyRect = (r: FloatRect) => {
		const el = rootRef.current;
		if (!el) return;
		el.style.left = r.x + "px";
		el.style.top = r.y + "px";
		el.style.width = r.w + "px";
		el.style.height = r.h + "px";
	};

	// 无依赖稳定引用：纯 DOM 操作，add/removeEventListener 始终同一函数对
	const onMouseMove = useCallback((e: MouseEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.startX;
		const dy = e.clientY - d.startY;
		const next = clampRect(
			d.kind === "move"
				? { ...d.base, x: d.base.x + dx, y: d.base.y + dy }
				: { ...d.base, w: d.base.w + dx, h: d.base.h + dy },
		);
		d.last = next;
		applyRect(next);
	}, []);

	const onMouseUp = useCallback(() => {
		const d = drag.current;
		if (!d) return;
		drag.current = null;
		document.body.style.userSelect = "";
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
		setDragging(false);
		onRectChange(d.last);
	}, [onMouseMove, onRectChange]);

	const startDrag = useCallback(
		(kind: "move" | "resize") => (e: React.MouseEvent) => {
			e.preventDefault();
			drag.current = {
				kind,
				startX: e.clientX,
				startY: e.clientY,
				base: rect,
				last: rect,
			};
			document.body.style.userSelect = "none";
			setDragging(true);
			window.addEventListener("mousemove", onMouseMove);
			window.addEventListener("mouseup", onMouseUp);
		},
		[rect, onMouseMove, onMouseUp],
	);

	// 非交互区域按住 = 拖动窗口（替代标题栏）；交互元素（按钮/地址栏输入等）正常响应
	const onWrapperMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
			startDrag("move")(e);
		},
		[startDrag],
	);

	return (
		<div
			ref={rootRef}
			data-testid="float-window"
			className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-2xl"
			style={{
				left: rect.x,
				top: rect.y,
				width: rect.w,
				height: rect.h,
				...animStyle,
			}}
			onMouseDown={onWrapperMouseDown}
		>
			{/* 拖拽中屏蔽内容区指针事件：防 iframe 吞掉 mousemove/mouseup */}
			<div
				className="flex-1 overflow-hidden"
				style={dragging ? { pointerEvents: "none" } : undefined}
				data-testid="float-content"
			>
				{children}
			</div>
			{/* 右下角缩放手柄（stopPropagation：避免冒泡到 wrapper 被当成移动拖拽） */}
			<div
				data-testid="float-resize"
				onMouseDown={(e) => {
					e.stopPropagation();
					startDrag("resize")(e);
				}}
				style={{
					position: "absolute",
					right: 0,
					bottom: 0,
					width: 14,
					height: 14,
					cursor: "nwse-resize",
					background:
						"linear-gradient(135deg, transparent 50%, var(--hairline-strong, #666) 50%)",
				}}
			/>
		</div>
	);
}
