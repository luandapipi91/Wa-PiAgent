// 缩略图条：同目录画廊可能有上千项，只渲染滚动窗口内的项（虚拟滚动），
// 全长用内层占位宽度撑起滚动条。点击回调原始索引，当前项高亮。
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { resolveMediaSrc, type MediaItem } from "./media-utils";

/** 单项步距（缩略图 48px + 间距 6px），与渲染样式保持一致 */
export const THUMB_STEP = 54;
/** 窗口两侧各多渲染的项数：滚动时不出现空白 */
const OVERSCAN = 6;
/** 无布局环境（happy-dom/首帧）下的视口宽度回落值 */
const FALLBACK_VIEWPORT = 800;

interface Props {
	items: MediaItem[];
	index: number;
	sessionId: string;
	onSelect: (index: number) => void;
}

export function ThumbStrip({ items, index, sessionId, onSelect }: Props) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [scrollLeft, setScrollLeft] = useState(0);
	const [viewport, setViewport] = useState(0);

	const containerWidth = () =>
		rootRef.current?.clientWidth || window.innerWidth || FALLBACK_VIEWPORT;

	// 视口宽度：窗口缩放时跟随（无 ResizeObserver 的环境只量一次）
	useEffect(() => {
		setViewport(containerWidth());
		const el = rootRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setViewport(containerWidth()));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// 当前项不可见时滚进窗口（打开定位与切换项都走这里）
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const w = containerWidth();
		const x = index * THUMB_STEP;
		if (x < el.scrollLeft) {
			el.scrollLeft = x;
			setScrollLeft(x);
		} else if (x + THUMB_STEP > el.scrollLeft + w) {
			const next = x + THUMB_STEP - w;
			el.scrollLeft = next;
			setScrollLeft(next);
		}
	}, [index, viewport]);

	const width = viewport || window.innerWidth || FALLBACK_VIEWPORT;
	const first = Math.max(0, Math.floor(scrollLeft / THUMB_STEP) - OVERSCAN);
	const last = Math.min(
		items.length - 1,
		Math.ceil((scrollLeft + width) / THUMB_STEP) + OVERSCAN,
	);

	return (
		<div
			ref={rootRef}
			className="px-3 py-2 border-t border-hairline bg-surface overflow-x-auto"
			data-testid="media-thumbs"
			onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
		>
			<div
				style={{
					position: "relative",
					height: 48,
					width: items.length * THUMB_STEP,
				}}
			>
				{items.slice(first, last + 1).map((it, i) => {
					const idx = first + i;
					return (
						<button
							key={idx}
							type="button"
							data-testid="media-thumb"
							title={it.name}
							onClick={() => onSelect(idx)}
							className={`absolute top-0 w-12 h-12 rounded border overflow-hidden flex items-center justify-center bg-canvas text-tertiary ${
								idx === index ? "border-accent" : "border-hairline"
							}`}
							style={{ left: idx * THUMB_STEP }}
						>
							{it.kind === "image" ? (
								<img
									src={resolveMediaSrc(it.src, sessionId)}
									alt={it.name}
									loading="lazy"
									className="w-full h-full object-cover"
								/>
							) : (
								<Icon name="play" size={16} />
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
