// 文件预览器：移植自 cocode 的 file-viewer，适配 WaPi 的 fs-client（HTTP REST + base64）。
// 支持：代码语法高亮(行号)、图片缩放/平移、大文件截断提示、选中复制为 @path:行号 引用。
import { Highlight, themes } from "prism-react-renderer";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readFile } from "../../fs-client";
import { createMarkdownComponents } from "./markdown-components";

// 图片扩展名集合（与 kernel checkPreviewable 放行的 image/* 对齐）
const IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"ico",
	"tiff",
	"tif",
	"avif",
	"apng",
]);

function extOf(path: string): string {
	return path.split(".").pop()?.toLowerCase() ?? "";
}

function isImagePath(path: string): boolean {
	return IMAGE_EXTS.has(extOf(path));
}

// 扩展名 → Prism 语言映射
function guessLanguage(path: string): string {
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		json: "json",
		rs: "rust",
		md: "markdown",
		css: "css",
		html: "html",
		py: "python",
		go: "go",
		java: "java",
		sh: "bash",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		sql: "sql",
		xml: "xml",
		svg: "markup",
		txt: "text",
	};
	return map[extOf(path)] ?? "text";
}

/** base64 → UTF-8 文本（kernel readFile 返回 base64，二进制安全） */
function decodeBase64(b64: string): string {
	const bin = atob(b64);
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

// md 预览 memo 化：react-markdown v10 无内置 memo，components 引用一变就全量重解析整份 md。
// FileViewer 挂在 SessionView 下，流式期间 SessionView 每帧重渲染 → 每帧重解析（上限 3MB）。
// 与聊天区 MarkdownBlock（React.memo）做法一致：只接收 content/sessionId 两个稳定 prop，
// 不接收 onClose 等新引用，保证组件引用不变时 React 跳过重渲染。
const MarkdownPreview = memo(function MarkdownPreview({ content, sessionId }: { content: string; sessionId: string }) {
  const mdComponents = useMemo(() => createMarkdownComponents(sessionId), [sessionId]);
  return (
    <div className="prose prose-sm max-w-none" data-testid="text-block">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</ReactMarkdown>
    </div>
  );
});

type FileViewerProps = {
	path: string;
	onClose: () => void;
	sessionId?: string;
};

/** 图片预览：滚轮缩放 + 拖拽平移 + 双击重置 */
function ImageViewer({
	src,
	alt,
	onClose,
}: {
	src: string;
	alt: string;
	onClose: () => void;
}) {
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef({ startX: 0, startY: 0, panX: 0, panY: 0 });
	const bodyRef = useRef<HTMLDivElement>(null);

	const clampZoom = (z: number) => Math.max(0.1, Math.min(20, z));
	const zoomReset = () => {
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
		<div className="flex flex-col h-full" data-testid="image-viewer">
			<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface">
				<span className="text-[12px] text-secondary flex-1 truncate">
					🖼️ {alt}
				</span>
				<button
					className="fv-btn"
					onClick={() => setZoom((z) => clampZoom(z / 1.25))}
					title="缩小"
				>
					➖
				</button>
				<span className="text-[11px] text-tertiary w-10 text-center">
					{Math.round(zoom * 100)}%
				</span>
				<button
					className="fv-btn"
					onClick={() => setZoom((z) => clampZoom(z * 1.25))}
					title="放大"
				>
					➕
				</button>
				<button className="fv-btn" onClick={onClose} title="关闭">
					✕
				</button>
			</div>
			<div
				ref={bodyRef}
				className="flex-1 overflow-hidden relative bg-canvas flex items-center justify-center p-2.5"
				onMouseDown={onMouseDown}
				onDoubleClick={zoomReset}
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

/** 文件预览器：文本/代码用 Prism 高亮，图片用 ImageViewer */
export function FileViewer({ path, onClose, sessionId }: FileViewerProps) {
	const [content, setContent] = useState<string | null>(null);
	const [imageSrc, setImageSrc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [unsupported, setUnsupported] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [resolvedPath, setResolvedPath] = useState<string | undefined>(
		undefined,
	);
	const bodyRef = useRef<HTMLDivElement>(null);
	const fileName = path.replace(/\\/g, "/").split("/").pop() ?? path;
	const language = guessLanguage(path);
	const image = isImagePath(path);
	const isMarkdown = extOf(path) === "md";

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		setUnsupported(null);
		setContent(null);
		setImageSrc(null);
		readFile(path)
			.then((r) => {
				if (!alive) return;
				setResolvedPath(r.resolvedPath);
				if (r.unsupported) {
					setUnsupported(r.unsupported);
					setLoading(false);
					return;
				}
				if (image) {
					// 图片：拼 data URI 供 <img> 直接加载
					setImageSrc(`data:${r.mimeType ?? "image/png"};base64,${r.content}`);
				} else {
					setContent(decodeBase64(r.content));
				}
				setLoading(false);
			})
			.catch((err: unknown) => {
				if (!alive) return;
				setError(
					`无法读取文件：${err instanceof Error ? err.message : "未知错误"}`,
				);
				setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [path, image]);

	// 选中代码复制为 @path:行号引用（拦截 copy 事件）
	useEffect(() => {
		if (content === null || isMarkdown) return;
		const el = bodyRef.current;
		if (!el) return;
		const displayPath = resolvedPath ?? path;
		const onCopy = (e: ClipboardEvent) => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) return;
			const lines = el.querySelectorAll("[data-line]");
			let startLine: number | null = null;
			let endLine: number | null = null;
			for (const lineEl of lines) {
				if (sel.containsNode(lineEl, true)) {
					const num = parseInt((lineEl as HTMLElement).dataset.line ?? "0", 10);
					if (startLine === null) startLine = num;
					endLine = num;
				}
			}
			if (startLine === null || endLine === null) return;
			e.preventDefault();
			const ref =
				startLine === endLine
					? `@${displayPath} :${startLine}`
					: `@${displayPath} :${startLine}-${endLine}`;
			e.clipboardData?.setData("text/plain", ref);
		};
		document.addEventListener("copy", onCopy);
		return () => document.removeEventListener("copy", onCopy);
	}, [path, content, resolvedPath, isMarkdown]);

	const displayPath = resolvedPath ?? path;

	// 复制 @path 或选中行的引用（copy-on-select：选中代码行后 Ctrl+C 自动复制为 @path:行号）
	if (loading) {
		return (
			<div
				className="flex items-center justify-center h-full text-tertiary text-[13px]"
				data-testid="fv-loading"
			>
				加载中…
			</div>
		);
	}

	if (unsupported) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-3"
				data-testid="fv-unsupported"
			>
				<span className="text-[32px]">📄</span>
				<span className="text-[13px] text-secondary">不支持预览该文件</span>
				<span className="text-[11px] text-tertiary">{unsupported}</span>
				<button className="fv-btn" onClick={onClose}>
					关闭
				</button>
			</div>
		);
	}

	if (error) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-3"
				data-testid="fv-error"
			>
				<span className="text-[13px] text-danger">{error}</span>
				<button className="fv-btn" onClick={onClose}>
					关闭
				</button>
			</div>
		);
	}

	if (image && imageSrc) {
		return <ImageViewer src={imageSrc} alt={fileName} onClose={onClose} />;
	}

	if (isMarkdown && content !== null) {
		return (
			<div className="flex flex-col h-full" data-testid="file-viewer">
				<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface">
					<span className="text-[12px] text-secondary flex-1 truncate font-mono">
						📄 {fileName}
					</span>
					<button className="fv-btn" onClick={onClose} title="关闭">
						✕
					</button>
				</div>
				{/* markdown 预览：左右内间距 20px（px-5），上下 10px（py-2.5） */}
				<div
					ref={bodyRef}
					className="flex-1 overflow-auto bg-canvas px-5 py-2.5"
				>
					<MarkdownPreview content={content} sessionId={sessionId ?? ""} />
				</div>
				<div
					className="px-3 py-1 text-[10.5px] text-tertiary border-t border-hairline bg-surface truncate"
					title={displayPath}
				>
					{displayPath}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full" data-testid="file-viewer">
			<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface">
				<span className="text-[12px] text-secondary flex-1 truncate font-mono">
					📄 {fileName}
				</span>
				<button className="fv-btn" onClick={onClose} title="关闭">
					✕
				</button>
			</div>
			<div ref={bodyRef} className="flex-1 overflow-auto bg-canvas p-2.5">
				<Highlight
					theme={themes.github}
					code={content ?? ""}
					language={language}
				>
					{({ tokens, getLineProps, getTokenProps }) => (
						<pre className="text-[12px] font-mono m-0">
							<code>
								{tokens.map((line, i) => (
									<div
										{...getLineProps({ line, key: i })}
										key={i}
										className="table-row"
										data-line={i + 1}
									>
										<span
											className="table-cell pr-3 text-right text-tertiary select-none"
											style={{ opacity: 0.6 }}
										>
											{i + 1}
										</span>
										<span className="table-cell whitespace-pre">
											{line.map((token, tKey) => (
												<span
													{...getTokenProps({ token, key: tKey })}
													key={tKey}
												/>
											))}
										</span>
									</div>
								))}
							</code>
						</pre>
					)}
				</Highlight>
			</div>
			<div
				className="px-3 py-1 text-[10.5px] text-tertiary border-t border-hairline bg-surface truncate"
				title={displayPath}
			>
				{displayPath}
			</div>
		</div>
	);
}
