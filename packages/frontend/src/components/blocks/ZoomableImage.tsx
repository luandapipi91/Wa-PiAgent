import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type ZoomControls = {
	zoom: number;
	zoomIn: () => void;
	zoomOut: () => void;
	reset: () => void;
};

/** 可缩放图片视口：滚轮缩放 + 拖拽平移 + 双击重置。
 *  从 FileViewer 的 ImageViewer 抽取，供 FileViewer 与 MediaPreviewModal 共用；
 *  缩放状态内部管理，工具栏由调用方经 renderToolbar 注入（FileViewer 需要缩放按钮与百分比）。 */
export function ZoomableImage({
	src,
	alt,
	renderToolbar,
}: {
	src: string;
	alt: string;
	renderToolbar?: (c: ZoomControls) => ReactNode;
}) {
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef({ startX: 0, startY: 0, panX: 0, panY: 0 });
	const bodyRef = useRef<HTMLDivElement>(null);

	const clampZoom = (z: number) => Math.max(0.1, Math.min(20, z));
	const reset = () => {
		setZoom(1);
		setPan({ x: 0, y: 0 });
	};

	// 滚轮缩放（手动绑定，关闭 passive 以便 preventDefault）
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			setZoom((z) => clampZoom(z + delta * z));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (zoom <= 1) return;
			e.preventDefault();
			setDragging(true);
			dragRef.current = {
				startX: e.clientX,
				startY: e.clientY,
				panX: pan.x,
				panY: pan.y,
			};
		},
		[zoom, pan],
	);

	useEffect(() => {
		if (!dragging) return;
		const onMove = (e: MouseEvent) => {
			const dx = e.clientX - dragRef.current.startX;
			const dy = e.clientY - dragRef.current.startY;
			setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy });
		};
		const onUp = () => setDragging(false);
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [dragging]);

	return (
		<div className="flex flex-col h-full" data-testid="zoomable-image">
			{renderToolbar?.({
				zoom,
				zoomIn: () => setZoom((z) => clampZoom(z * 1.25)),
				zoomOut: () => setZoom((z) => clampZoom(z / 1.25)),
				reset,
			})}
			<div
				ref={bodyRef}
				className="flex-1 overflow-hidden relative bg-canvas flex items-center justify-center p-2.5"
				onMouseDown={onMouseDown}
				onDoubleClick={reset}
				style={{
					cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
				}}
			>
				<img
					src={src}
					alt={alt}
					draggable={false}
					className="max-w-full max-h-full select-none"
					style={{
						transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
						transformOrigin: "center center",
					}}
				/>
			</div>
		</div>
	);
}
