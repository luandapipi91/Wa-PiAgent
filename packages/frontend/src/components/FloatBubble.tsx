import { useCallback, useRef } from "react";
import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";
import { BUBBLE_SIZE, clampBubblePos, type BubblePos } from "../store/browser";

/** 气泡动画样式（模块级注入一次）：出现 pop-in + 待机呼吸脉冲 */
let bubbleStyleInjected = false;
function ensureBubbleStyles() {
	if (bubbleStyleInjected || typeof document === "undefined") return;
	bubbleStyleInjected = true;
	const style = document.createElement("style");
	style.textContent = `
		@keyframes wa-pi-bubble-in {
			from { transform: scale(0.3); opacity: 0; }
			to { transform: scale(1); opacity: 1; }
		}
		@keyframes wa-pi-bubble-pulse {
			0%, 100% { box-shadow: 0 4px 16px rgba(0,0,0,.35), 0 0 0 0 var(--accent-soft, rgba(91,91,214,.45)); }
			50% { box-shadow: 0 4px 16px rgba(0,0,0,.35), 0 0 0 10px transparent; }
		}
		.wa-pi-float-bubble {
			animation: wa-pi-bubble-in 0.18s ease-out, wa-pi-bubble-pulse 2.4s ease-in-out 0.2s infinite;
		}
	`;
	document.head.appendChild(style);
}

interface Props {
	pos: BubblePos;
	/** 拖动结束（mouseup）提交新位置（store 侧 clamp + 持久化） */
	onPosChange: (p: BubblePos) => void;
	/** 点击（未拖动）恢复预览 */
	onRestore: () => void;
}

/**
 * 浮动窗最小化气泡：点击恢复预览，可拖动停放位置（拖完持久化）。
 * 拖动与点击按位移阈值（5px）区分；拖拽中直接改 DOM，mouseup 一次性提交。
 */
export function FloatBubble({ pos, onPosChange, onRestore }: Props) {
	const { t } = useTranslation();
	ensureBubbleStyles();
	const rootRef = useRef<HTMLButtonElement | null>(null);
	const drag = useRef<{
		startX: number;
		startY: number;
		base: BubblePos;
		moved: boolean;
		last?: BubblePos;
	} | null>(null);

	const onMouseMove = useCallback((e: MouseEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.startX;
		const dy = e.clientY - d.startY;
		if (!d.moved && Math.abs(dx) + Math.abs(dy) <= 5) return;
		d.moved = true;
		const next = clampBubblePos({ x: d.base.x + dx, y: d.base.y + dy });
		const el = rootRef.current;
		if (el) {
			el.style.left = next.x + "px";
			el.style.top = next.y + "px";
		}
		d.last = next;
	}, []);

	const onMouseUp = useCallback(() => {
		const d = drag.current;
		if (!d) return;
		drag.current = null;
		document.body.style.userSelect = "";
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
		if (d.moved && d.last) onPosChange(d.last);
		else if (!d.moved) onRestore();
	}, [onMouseMove, onPosChange, onRestore]);

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			drag.current = {
				startX: e.clientX,
				startY: e.clientY,
				base: pos,
				moved: false,
			};
			document.body.style.userSelect = "none";
			window.addEventListener("mousemove", onMouseMove);
			window.addEventListener("mouseup", onMouseUp);
		},
		[pos, onMouseMove, onMouseUp],
	);

	return (
		<button
			ref={rootRef}
			type="button"
			data-testid="float-bubble"
			title={t("browser.restore")}
			onMouseDown={onMouseDown}
			className="wa-pi-float-bubble fixed z-50 flex items-center justify-center rounded-full bg-surface border border-hairline text-secondary hover:text-brand cursor-pointer"
			style={{ left: pos.x, top: pos.y, width: BUBBLE_SIZE, height: BUBBLE_SIZE }}
		>
			<Icon name="globe" size={20} />
		</button>
	);
}
