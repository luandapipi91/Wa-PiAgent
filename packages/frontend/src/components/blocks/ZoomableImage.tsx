import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	type ReactNode,
	type Ref,
} from "react";

export type ZoomControls = {
	zoom: number;
	zoomIn: () => void;
	zoomOut: () => void;
	reset: () => void;
};

/** 图片变换（缩放 + 平移偏移）：预览与标注态共用同一形状，进入/退出编辑时交接，
 *  避免用户放大到某一处后一进编辑就被重置回 100%。 */
export type ImageTransform = { zoom: number; pan: { x: number; y: number } };

/** 平移量：随缩放放大可视角，避免缩得大时图片被拖出画面再也拉不回来 */
export const clampPan = (
	pan: { x: number; y: number },
	zoom: number,
	baseWidth: number,
	baseHeight: number,
): { x: number; y: number } => {
	const maxX = Math.max(0, ((zoom - 1) * baseWidth) / 2);
	const maxY = Math.max(0, ((zoom - 1) * baseHeight) / 2);
	return {
		x: Math.max(-maxX, Math.min(maxX, pan.x)),
		y: Math.max(-maxY, Math.min(maxY, pan.y)),
	};
};

/** 缩放范围夹取（0.1x ~ 20x）；纯函数，提到模块级供命令回调用 */
const clampZoom = (z: number) => Math.max(0.1, Math.min(20, z));

/** 可缩放图片视口：滚轮缩放 + 拖拽平移 + 双击重置。
 *  从 FileViewer 的 ImageViewer 抽取，供 FileViewer 与 MediaPreviewModal 共用；
 *  缩放状态内部管理，工具栏可由调用方经 renderToolbar 注入（FileViewer 需要缩放按钮与百分比），
 *  或经 controlsRef 拿到缩放命令、由 onZoomChange 订阅百分比（MediaPreviewModal 的控件
 *  在浮层顶部栏，位于组件外部）。 */
export function ZoomableImage({
	src,
	alt,
	renderToolbar,
	controlsRef,
	onZoomChange,
	initialZoom,
	initialPan,
	onTransformChange,
}: {
	src: string;
	alt: string;
	renderToolbar?: (c: ZoomControls) => ReactNode;
	/** 对外暴露缩放命令（控件渲染在组件外部时使用） */
	controlsRef?: Ref<ZoomControls>;
	/** 缩放值变化回调（供外部展示百分比） */
	onZoomChange?: (zoom: number) => void;
	/** 初始缩放：从标注态返回时沿用其缩放，不重置回 100% */
	initialZoom?: number;
	/** 初始平移：同上 */
	initialPan?: { x: number; y: number };
	/** 缩放/平移变化上报（父组件存起来，进出标注态交接） */
	onTransformChange?: (t: ImageTransform) => void;
}) {
	const [zoom, setZoom] = useState(() => clampZoom(initialZoom ?? 1));
	const [pan, setPan] = useState(initialPan ?? { x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef({ startX: 0, startY: 0, panX: 0, panY: 0 });
	const bodyRef = useRef<HTMLDivElement>(null);

	const reset = useCallback(() => {
		setZoom(1);
		setPan({ x: 0, y: 0 });
	}, []);
	const zoomIn = useCallback(() => setZoom((z) => clampZoom(z * 1.25)), []);
	const zoomOut = useCallback(() => setZoom((z) => clampZoom(z / 1.25)), []);

	useImperativeHandle(
		controlsRef,
		() => ({ zoom, zoomIn, zoomOut, reset }),
		[zoom, zoomIn, zoomOut, reset],
	);

	useEffect(() => {
		onZoomChange?.(zoom);
	}, [zoom, onZoomChange]);

	useEffect(() => {
		onTransformChange?.({ zoom, pan });
	}, [zoom, pan, onTransformChange]);

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
		<div className="flex flex-col h-full w-full" data-testid="zoomable-image">
			{renderToolbar?.({ zoom, zoomIn, zoomOut, reset })}
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
