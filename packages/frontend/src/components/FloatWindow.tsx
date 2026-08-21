import { useCallback, useRef } from "react";
import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";
import type { FloatRect } from "../store/browser";

interface Props {
	rect: FloatRect;
	title: string;
	/** 拖动/缩放中持续回调（store 侧负责 clamp + 持久化） */
	onRectChange: (r: FloatRect) => void;
	/** 停靠回分屏 */
	onDock: () => void;
	onClose: () => void;
	children: React.ReactNode;
}

/**
 * 浮动预览窗：标题栏拖动位置、右下角手柄拖尺寸。
 * 拖拽模式复刻 SidebarResizer：mousedown 启动，window 级 mousemove/mouseup 驱动。
 */
export function FloatWindow({
	rect,
	title,
	onRectChange,
	onDock,
	onClose,
	children,
}: Props) {
	const { t } = useTranslation();
	const drag = useRef<{
		kind: "move" | "resize";
		startX: number;
		startY: number;
		base: FloatRect;
	} | null>(null);

	const onMouseMove = useCallback(
		(e: MouseEvent) => {
			const d = drag.current;
			if (!d) return;
			const dx = e.clientX - d.startX;
			const dy = e.clientY - d.startY;
			onRectChange(
				d.kind === "move"
					? { ...d.base, x: d.base.x + dx, y: d.base.y + dy }
					: { ...d.base, w: d.base.w + dx, h: d.base.h + dy },
			);
		},
		[onRectChange],
	);

	const onMouseUp = useCallback(() => {
		if (!drag.current) return;
		drag.current = null;
		document.body.style.userSelect = "";
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
	}, [onMouseMove]);

	const startDrag = useCallback(
		(kind: "move" | "resize") => (e: React.MouseEvent) => {
			e.preventDefault();
			drag.current = { kind, startX: e.clientX, startY: e.clientY, base: rect };
			document.body.style.userSelect = "none";
			window.addEventListener("mousemove", onMouseMove);
			window.addEventListener("mouseup", onMouseUp);
		},
		[rect, onMouseMove, onMouseUp],
	);

	return (
		<div
			data-testid="float-window"
			className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-2xl"
			style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
		>
			<div
				data-testid="float-titlebar"
				onMouseDown={startDrag("move")}
				className="flex items-center gap-1 px-3 py-1.5 border-b border-hairline cursor-move select-none"
			>
				<span className="flex-1 truncate text-xs text-secondary">{title}</span>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.dock")}
					data-testid="float-dock"
					onClick={onDock}
				>
					<Icon name="columns" size="1em" />
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("common.close")}
					data-testid="float-close"
					onClick={onClose}
					style={{ color: "var(--danger)" }}
				>
					<Icon name="x" size="1em" />
				</button>
			</div>
			<div className="flex-1 overflow-hidden">{children}</div>
			{/* 右下角缩放手柄 */}
			<div
				data-testid="float-resize"
				onMouseDown={startDrag("resize")}
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
