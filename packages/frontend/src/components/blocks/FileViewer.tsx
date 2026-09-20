// 文件预览器：移植自 cocode 的 file-viewer，适配 WaPi 的 fs-client（HTTP REST + base64）。
// 支持：代码语法高亮(行号)、图片缩放/平移、大文件截断提示、选中复制为 @path:行号 引用。
// 标题栏带 data-modal-drag-handle：预览窗（FilePreviewModal）按住标题栏可拖动整个窗口。
import { Highlight, themes } from "prism-react-renderer";
// 注册内置缺失的主流语言（bash/java/csharp/ruby/toml），side-effect：加载即注入内置 Prism
import "./prism-extra-langs";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import rehypeRaw from "rehype-raw";
import type { Components } from "react-markdown";
import { readFile, revealFile, openFileWithDefaultApp } from "../../fs-client";
import { useTranslation } from "../../i18n/useTranslation";
import { Markdown } from "./Markdown";
import { MarkdownLink } from "./markdown-components";
import { joinBaseDir } from "./media-utils";
import { ZoomableImage } from "./ZoomableImage";
import { openInFileManagerLabel } from "../../util/platform";
import {
	copyToClipboard,
	copyImageToClipboard,
	imageUrlToPngBlob,
} from "../../util/clipboard";
import { useSessionStore } from "../../store/session";
import { useToastStore } from "../../store/toast";
import { Icon } from "../ui/Icon";
import { ShareButton } from "../ui/ShareButton";
import { useIsDarkMode } from "../../theme/use-is-dark-mode";

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
		vue: "markup",
		json: "json",
		rs: "rust",
		md: "markdown",
		css: "css",
		html: "html",
		py: "python",
		go: "go",
		java: "java",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		kt: "kotlin",
		kts: "kotlin",
		swift: "swift",
		cs: "csharp",
		rb: "ruby",
		h: "c",
		hpp: "cpp",
		cc: "cpp",
		xx: "cpp",
		cpp: "cpp",
		c: "c",
		mjs: "javascript",
		cjs: "javascript",
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

/** md 内嵌图片：远程 URL/绝对路径直接使用，相对路径基于预览文件所在目录解析，经 fs-client 读成 data URI 显示 */
function PreviewImage({
	src,
	alt,
	baseDir,
	width,
	height,
}: {
	src?: string;
	alt?: string;
	baseDir: string;
	width?: number | string;
	height?: number | string;
}) {
	const [dataSrc, setDataSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let alive = true;
		setDataSrc(null);
		setFailed(false);
		if (!src) return;
		// 远程 URL / data URI / 绝对路径（/ 开头或 Windows 盘符）：直接使用
		if (
			/^(https?:|data:|blob:|file:)/i.test(src) ||
			src.startsWith("/") ||
			/^[A-Za-z]:[\\/]/.test(src)
		) {
			setDataSrc(src);
			return;
		}
		// 相对路径：基于预览文件所在目录解析
		const abs = baseDir ? joinBaseDir(baseDir, src) : src;
		readFile(abs)
			.then((r) => {
				if (!alive) return;
				if (r.unsupported || !r.mimeType?.startsWith("image/")) {
					setFailed(true);
					return;
				}
				setDataSrc(`data:${r.mimeType};base64,${r.content}`);
			})
			.catch(() => {
				if (alive) setFailed(true);
			});
		return () => {
			alive = false;
		};
	}, [src, baseDir]);

	if (failed) {
		return (
			<span className="inline-block text-tertiary text-[calc(12px*var(--font-scale))]">
				[图片加载失败]
			</span>
		);
	}
	if (!dataSrc) {
		return (
			<span className="inline-block text-tertiary text-[calc(12px*var(--font-scale))]">
				加载中…
			</span>
		);
	}
	return <img src={dataSrc} alt={alt ?? ""} width={width} height={height} />;
}

// md 预览 memo 化：react-markdown v10 无内置 memo，components 引用一变就全量重解析整份 md。
// FileViewer 挂在 SessionView 下，流式期间 SessionView 每帧重渲染 → 每帧重解析（上限 5MB）。
// 与聊天区 MarkdownBlock（React.memo）做法一致：只接收 content/sessionId 两个稳定 prop，
// 不接收 onClose 等新引用，保证组件引用不变时 React 跳过重渲染。
const MarkdownPreview = memo(function MarkdownPreview({
	content,
	sessionId,
	baseDir,
}: {
	content: string;
	sessionId: string;
	baseDir: string;
}) {
	// 只保留本处需要的覆盖项（img/a）：基础映射由统一组件提供。
	// 覆盖 img 即天然关闭图片网格聚合（markdown-components 的 p 聚合按引用判定，契约见该文件）。
	const overrides = useMemo<Components>(() => {
		return {
			// md 内嵌图片：相对路径解析为基于预览文件目录的本地文件；
			// width/height 透传（README 里 <img width="96"> 的尺寸不能丢）
			img: (props: any) => (
				<PreviewImage
					src={props.src}
					alt={props.alt}
					baseDir={baseDir}
					width={props.width}
					height={props.height}
				/>
			),
			// md 里的链接：
			// - 相对路径（指向仓库内其他文件）→ 在预览器内打开目标文件（与 FilePill 同机制）
			// - 外部链接（http/https/mailto 等）→ MarkdownLink target=_blank → setWindowOpenHandler → 应用内新窗口打开
			a: (props: any) => {
				const href = props.href ?? "";
				if (href && !/^(https?:|mailto:|tel:|#|data:|blob:|file:)/i.test(href)) {
					const abs =
						`${baseDir.replace(/\\/g, "/").replace(/\/$/, "")}/${href.replace(/^\.\//, "")}`.replace(
							/\/+/g,
							"/",
						);
					return (
						<a
							{...props}
							onClick={(e) => {
								e.preventDefault();
								useSessionStore.getState().openFilePreview(abs, sessionId);
							}}
						/>
					);
				}
				return <MarkdownLink {...props} />;
			},
		};
	}, [sessionId, baseDir]);
	return (
		<Markdown
			text={content}
			sessionId={sessionId}
			rehypePlugins={[rehypeRaw]}
			components={overrides}
		/>
	);
});

type FileViewerProps = {
	path: string;
	onClose: () => void;
	sessionId?: string;
};

/** 图片预览：滚轮缩放 + 拖拽平移 + 双击重置（视口复用 ZoomableImage，本组件只提供工具栏） */
function ImageViewer({
	src,
	alt,
	onClose,
}: {
	src: string;
	alt: string;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const addToast = useToastStore((s) => s.add);
	// 复制图片：fetch 取 blob → canvas 转 PNG → 剪贴板（剪贴板只保证支持 PNG）
	const copyImage = async () => {
		try {
			await copyImageToClipboard(await imageUrlToPngBlob(src));
			addToast(t("common.copiedToClipboard"), "success");
		} catch {
			addToast(t("common.copyFailed"), "error");
		}
	};
	return (
		<div className="flex flex-col h-full" data-testid="image-viewer">
			<ZoomableImage
				src={src}
				alt={alt}
				renderToolbar={({ zoom, zoomIn, zoomOut }) => (
					<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface" data-modal-drag-handle="">
						<span className="text-[calc(12px*var(--font-scale))] text-secondary flex-1 truncate inline-flex items-center gap-1">
							<Icon name="image" size={13} /> {alt}
						</span>
						<button
							className="fv-btn"
							onClick={zoomOut}
							title={t("blocks.fileViewer.zoomOut")}
						>
							<Icon name="minus" size={12} />
						</button>
						<span className="text-[calc(11px*var(--font-scale))] text-tertiary w-10 text-center">
							{Math.round(zoom * 100)}%
						</span>
						<button
							className="fv-btn"
							onClick={zoomIn}
							title={t("blocks.fileViewer.zoomIn")}
						>
							<Icon name="plus" size={12} />
						</button>
						<button
							className="fv-btn"
							onClick={copyImage}
							title={t("blocks.fileViewer.copyImage")}
							data-testid="fv-copy-image"
						>
							<Icon name="clipboard" size={12} />
						</button>
						<button className="fv-btn" onClick={onClose} title={t("common.close")}>
							<Icon name="x" size={12} />
						</button>
					</div>
				)}
			/>
		</div>
	);
}

/** 文件预览器：文本/代码用 Prism 高亮，图片用 ImageViewer */
/** 文件预览底部地址栏：完整路径 + 复制按钮（点击复制路径，toast 反馈） */
const PathBar = memo(function PathBar({ path }: { path: string }) {
	const { t } = useTranslation();
	const addToast = useToastStore((s) => s.add);
	const copy = async () => {
		try {
			await copyToClipboard(path);
			addToast(t("common.copiedToClipboard"), "success");
		} catch {
			addToast(t("common.copyFailed"), "error");
		}
	};
	return (
		<div className="flex items-center gap-1 px-3 py-1 text-[calc(10.5px*var(--font-scale))] text-tertiary border-t border-hairline bg-surface">
			<span className="flex-1 truncate" title={path}>
				{path}
			</span>
			<button
				type="button"
				onClick={copy}
				title={t("common.copy")}
				aria-label={t("common.copy")}
				data-testid="fv-copy-path"
				className="shrink-0 inline-flex items-center text-tertiary hover:text-primary transition-colors cursor-pointer"
			>
				<Icon name="clipboard" size={13} />
			</button>
		</div>
	);
});

/** 虚拟滚动的块大小（行/块）与基准行高（行高实测后会修正）。
 *
 *  kernel 只拦 >5MB 的文件，≤5MB 的文本会整份送进渲染层；若把整份文本交给高亮组件，
 *  全量 Prism 分词 + 每 token 一个 <span>（5MB ≈ 190 万 token ≈ 200 万 DOM 节点，
 *  分词本身 2.3 秒）会冻结渲染进程。截断能救性能但影响浏览，因此改为**块级虚拟滚动**：
 *  只把可视区域内的块交给高亮组件渲染，内容保持完整、可滚动浏览全文。 */
const VIRTUAL_CHUNK_LINES = 200;
const DEFAULT_LINE_HEIGHT = 18;

/** markdown 单块的最大行数：超过就强制切分（兜底，避免一个巨大块把渲染卡住） */
const MD_BLOCK_MAX_LINES = 200;

/** markdown 里可跨空行包住内容的 HTML 块级容器。
 *  这类标签闭合前不能把空行/标题当块边界：每块单独解析（rehype-raw），
 *  开标签与内容一旦分处不同块就无法配对，align/text-align 等继承样式随之丢失
 *  （README 顶部 `<div align="center">` 里的居中 logo 曾因此变左对齐）。 */
const HTML_CONTAINER_TAGS = new Set([
	"div",
	"p",
	"center",
	"section",
	"article",
	"aside",
	"header",
	"footer",
	"main",
	"nav",
	"figure",
	"figcaption",
	"details",
	"summary",
	"blockquote",
	"pre",
	"form",
	"fieldset",
	"iframe",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"caption",
	"colgroup",
	"ul",
	"ol",
	"li",
	"dl",
	"dt",
	"dd",
	"video",
	"audio",
	"picture",
	"svg",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
]);

/** HTML 标签匹配（模块级 /g 正则：使用前必须重置 lastIndex） */
const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
/** markdown 块高度的估算参数（块高度不固定，实测前用它们占位） */
const MD_ESTIMATED_LINE_HEIGHT = 22;
const MD_ESTIMATED_BLOCK_PADDING = 16;

export interface MarkdownBlock {
	/** 0-based 起止行（含） */
	startLine: number;
	endLine: number;
	text: string;
}

/** 估算单个 markdown 块的高度（未实测时用于占位） */
export function estimateMarkdownBlockHeight(block: MarkdownBlock): number {
	return (
		(block.endLine - block.startLine + 1) * MD_ESTIMATED_LINE_HEIGHT +
		MD_ESTIMATED_BLOCK_PADDING
	);
}

/**
 * 把 markdown 切成「顶层块」，供块级虚拟滚动渲染。
 *
 * 切分意图是**宁可少切也不破坏结构**：
 *  1. 围栏代码块（``` / ~~~）内部不切分——否则会把代码块劈成两半；
 *  2. 标题行起新块（标题天然是章节边界）；
 *  3. 空行之后的下一个非空行可作为块起点（段落/表格/列表之间的安全边界）；
 *  4. 单块超过 MD_BLOCK_MAX_LINES 行时强制切分（兜底：无空行、无标题的超长文本）。
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
	const lines = text.split("\n");
	const blocks: MarkdownBlock[] = [];
	let start = 0;
	let inFence = false;
	let fenceChar = "";
	/** 尚未闭合的 HTML 块级容器栈 */
	const htmlStack: string[] = [];

	/** 扫描一行的 HTML 标签以维护容器栈（行内代码/HTML 注释里的标签不参与配对） */
	const scanHtmlTags = (line: string) => {
		const src = line.replace(/`[^`]*`/g, "").replace(/<!--.*?-->/g, "");
		HTML_TAG_RE.lastIndex = 0;
		for (let m = HTML_TAG_RE.exec(src); m; m = HTML_TAG_RE.exec(src)) {
			const tag = m[2].toLowerCase();
			if (!HTML_CONTAINER_TAGS.has(tag)) continue;
			if (m[1] === "/") {
				// 闭合：连同它内部未闭合的同名标签一起出栈
				const at = htmlStack.lastIndexOf(tag);
				if (at >= 0) htmlStack.length = at;
			} else if (!/\/\s*>$/.test(m[0])) {
				htmlStack.push(tag);
			}
		}
	};

	const flush = (endExclusive: number) => {
		if (endExclusive <= start) return;
		blocks.push({
			startLine: start,
			endLine: endExclusive - 1,
			text: lines.slice(start, endExclusive).join("\n"),
		});
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// 4) 兜底：单块超过上限就切（即使当前在围栏内，也只能切，否则无法虚拟化）
		if (i - start + 1 > MD_BLOCK_MAX_LINES) {
			flush(i);
			start = i;
		}

		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			const ch = fence[1][0];
			if (!inFence) {
				inFence = true;
				fenceChar = ch;
			} else if (ch === fenceChar) {
				inFence = false;
			}
		}
		if (inFence) continue; // 1) 围栏内不切

		// 先记录「本行是否处于未闭合的 HTML 容器内」（闭标签行也算内部），再更新容器栈
		const insideHtmlContainer = htmlStack.length > 0;
		scanHtmlTags(line);

		if (i <= start) continue;
		// 0) 容器内不切：否则开/闭标签与内容分属不同块，居中/对齐等继承样式丢失
		if (insideHtmlContainer) continue;
		// 2) 标题起新块
		if (/^#{1,6}\s/.test(line)) {
			flush(i);
			start = i;
			continue;
		}
		// 3) 空行后的第一个非空行起新块
		if (lines[i - 1].trim() === "" && line.trim() !== "") {
			flush(i);
			start = i;
		}
	}
	flush(lines.length);

	return blocks.length > 0
		? blocks
		: [{ startLine: 0, endLine: Math.max(0, lines.length - 1), text }];
}

/**
 * 按块偏移量计算可视窗口（纯函数）。
 * offsets 长度 = 块数 + 1，offsets[i] 为第 i 块顶部偏移；占位高度按未渲染块的实际/估算高度求和，
 * 因此滚动条长度与全文一致（块高度实测后会收敛）。
 */
export function computeBlockWindow(opts: {
	offsets: number[];
	scrollTop: number;
	viewportHeight: number;
	overscan?: number;
}): { first: number; last: number; topSpacer: number; bottomSpacer: number } {
	const blockCount = Math.max(0, opts.offsets.length - 1);
	if (blockCount === 0)
		return { first: 0, last: -1, topSpacer: 0, bottomSpacer: 0 };

	const overscan = opts.overscan ?? 1;
	const top = Math.max(0, opts.scrollTop);
	const bottom = top + Math.max(0, opts.viewportHeight);

	let first = 0;
	while (first < blockCount - 1 && opts.offsets[first + 1] <= top) first++;
	let last = first;
	while (last < blockCount - 1 && opts.offsets[last + 1] < bottom) last++;

	first = Math.max(0, first - overscan);
	last = Math.min(blockCount - 1, last + overscan);

	const topSpacer = opts.offsets[first];
	const bottomSpacer = Math.max(
		0,
		opts.offsets[blockCount] - opts.offsets[last + 1],
	);
	return { first, last, topSpacer, bottomSpacer };
}

/** 计算可视窗口：返回要渲染的块区间与上下占位高度（纯函数，便于单测）。
 *
 *  占位用「未渲染行数 × 行高」，因此滚动条长度与全文一致；overscan 多渲染一屏外的块，
 *  避免快速滚动时出现空白。 */
export function computeChunkWindow(opts: {
	scrollTop: number;
	viewportHeight: number;
	totalLines: number;
	chunkLines: number;
	lineHeight: number;
	overscanChunks?: number;
}): {
	firstChunk: number;
	lastChunk: number;
	topSpacer: number;
	bottomSpacer: number;
	chunkHeight: number;
} {
	const chunkHeight = Math.max(1, opts.chunkLines * opts.lineHeight);
	const totalChunks = Math.max(1, Math.ceil(opts.totalLines / opts.chunkLines));
	const overscan = opts.overscanChunks ?? 1;
	const viewport = Math.max(0, opts.viewportHeight);
	const firstChunk = Math.max(
		0,
		Math.floor(opts.scrollTop / chunkHeight) - overscan,
	);
	const lastChunk = Math.min(
		totalChunks - 1,
		Math.floor((opts.scrollTop + viewport) / chunkHeight) + overscan,
	);
	const topSpacer = firstChunk * chunkHeight;
	const renderedEndLine = Math.min(
		opts.totalLines,
		(lastChunk + 1) * opts.chunkLines,
	);
	const bottomSpacer = Math.max(
		0,
		(opts.totalLines - renderedEndLine) * opts.lineHeight,
	);
	return { firstChunk, lastChunk, topSpacer, bottomSpacer, chunkHeight };
}

export function FileViewer({ path, onClose, sessionId }: FileViewerProps) {
	const [content, setContent] = useState<string | null>(null);
	const [imageSrc, setImageSrc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [unsupported, setUnsupported] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();
	const isDark = useIsDarkMode();
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
					t("blocks.fileViewer.readError", {
						message:
							err instanceof Error ? err.message : t("blocks.fileViewer.unknownError"),
					}),
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

	// 虚拟滚动：按块切分全文，只把可视块交给高亮组件（必须放在组件体，JSX 要用）
	const allLines = useMemo(
		() => (content === null ? [] : content.split("\n")),
		[content],
	);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(0);
	const [lineHeight, setLineHeight] = useState(DEFAULT_LINE_HEIGHT);

	// 测量视口高度与实际行高（行高随 --font-scale 缩放，实测后修正以保证滚动位置准确）
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const measure = () => {
			setViewportHeight(el.clientHeight);
			const probe = el.querySelector<HTMLElement>("[data-line]");
			const h = probe?.offsetHeight ?? 0;
			if (h > 0) setLineHeight(h);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [content]);

	const chunkWindow = computeChunkWindow({
		scrollTop,
		// 首帧/无测量环境（如测试）拿不到真实高度时用兜底值，保证首屏可渲染
		viewportHeight: viewportHeight > 0 ? viewportHeight : 600,
		totalLines: allLines.length,
		chunkLines: VIRTUAL_CHUNK_LINES,
		lineHeight,
	});
	// —— markdown 块级虚拟滚动：块高度不固定，实测后缓存（未实测用估算占位）——
	const mdBlocks = useMemo(
		() => (isMarkdown && content !== null ? splitMarkdownBlocks(content) : []),
		[isMarkdown, content],
	);
	const [mdHeights, setMdHeights] = useState<Record<number, number>>({});
	const mdOffsets = useMemo(() => {
		const offs = new Array<number>(mdBlocks.length + 1);
		offs[0] = 0;
		for (let i = 0; i < mdBlocks.length; i++) {
			offs[i + 1] =
				offs[i] + (mdHeights[i] ?? estimateMarkdownBlockHeight(mdBlocks[i]));
		}
		return offs;
	}, [mdBlocks, mdHeights]);
	const mdWindow = computeBlockWindow({
		offsets: mdOffsets,
		scrollTop,
		viewportHeight: viewportHeight > 0 ? viewportHeight : 600,
	});
	const visibleMdBlocks: number[] = [];
	for (let i = mdWindow.first; i <= mdWindow.last; i++) visibleMdBlocks.push(i);

	// 实测 md 块高度：测量结果写回 mdHeights，占位高度随之收敛到真实值
	useEffect(() => {
		if (typeof ResizeObserver === "undefined") return;
		const body = bodyRef.current;
		if (!body) return;
		const els = body.querySelectorAll<HTMLElement>("[data-md-block]");
		if (els.length === 0) return;
		const ro = new ResizeObserver((entries) => {
			setMdHeights((prev) => {
				let next = prev;
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const index = Number(el.dataset.mdBlock);
					const h = el.offsetHeight;
					if (!Number.isFinite(index) || h <= 0 || next[index] === h) continue;
					if (next === prev) next = { ...prev };
					next[index] = h;
				}
				return next;
			});
		});
		for (const el of els) ro.observe(el);
		return () => ro.disconnect();
	}, [mdBlocks, mdWindow.first, mdWindow.last]);

	const visibleChunks: number[] = [];
	for (let i = chunkWindow.firstChunk; i <= chunkWindow.lastChunk; i++) {
		visibleChunks.push(i);
	}

	const addToast = useToastStore((s) => s.add);
	// 复制全文：content 始终是完整文件（渲染层虚拟滚动，不截断）
	const copyContent = async () => {
		try {
			await copyToClipboard(content ?? "");
			addToast(t("common.copiedToClipboard"), "success");
		} catch {
			addToast(t("common.copyFailed"), "error");
		}
	};

	// 复制 @path 或选中行的引用（copy-on-select：选中代码行后 Ctrl+C 自动复制为 @path:行号）
	if (loading) {
		return (
			<div
				className="flex items-center justify-center h-full text-tertiary text-[calc(13px*var(--font-scale))]"
				data-testid="fv-loading"
			>
				{t("blocks.fileViewer.loading")}
			</div>
		);
	}

	if (unsupported) {
		return (
			<div className="flex flex-col h-full" data-testid="fv-unsupported">
				<div className="flex-1 flex flex-col items-center justify-center gap-3">
					<span className="text-[calc(32px*var(--font-scale))] inline-flex text-tertiary">
						<Icon name="file" size={32} />
					</span>
					<span className="text-[calc(13px*var(--font-scale))] text-secondary">
						{t("blocks.fileViewer.unsupported")}
					</span>
					<span className="text-[calc(11px*var(--font-scale))] text-tertiary">
						{unsupported}
					</span>
					<div className="flex items-center gap-2">
						<button
							className="fv-empty-btn"
							onClick={() => void openFileWithDefaultApp(path)}
							data-testid="fv-open-default"
						>
							{t("common.openWithDefaultApp")}
						</button>
						<button
							className="fv-empty-btn"
							onClick={() => void revealFile(path)}
							data-testid="fv-reveal"
						>
							{openInFileManagerLabel({
								mac: t("common.openInFinder"),
								windows: t("common.openInExplorer"),
								linux: t("common.openInFileManager"),
							})}
						</button>
						<button className="fv-empty-btn" onClick={onClose}>
							{t("common.close")}
						</button>
					</div>
				</div>
				<PathBar path={displayPath} />
			</div>
		);
	}

	if (error) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-3"
				data-testid="fv-error"
			>
				<span className="text-[calc(13px*var(--font-scale))] text-danger">
					{error}
				</span>
				<button className="fv-empty-btn" onClick={onClose}>
					{t("common.close")}
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
				<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface" data-modal-drag-handle="">
					<span className="text-[calc(12px*var(--font-scale))] text-secondary flex-1 truncate font-mono inline-flex items-center gap-1">
						<Icon name="file" size={12} /> {fileName}
					</span>
					<ShareButton
						paths={[resolvedPath ?? path]}
						sessionId={sessionId}
						className="fv-btn"
						testId="share-file-btn"
					/>
					<button
						className="fv-btn"
						onClick={copyContent}
						title={t("common.copy")}
						aria-label={t("common.copy")}
						data-testid="fv-copy-content"
					>
						<Icon name="clipboard" size={12} />
					</button>
					<button className="fv-btn" onClick={onClose} title={t("common.close")}>
						<Icon name="x" size={12} />
					</button>
				</div>
				{/* markdown 预览：左右内间距 20px（px-5），上下 10px（py-2.5）。
				    块级虚拟滚动：只渲染可视块，块高度实测后缓存用于精确占位。 */}
				<div
					ref={bodyRef}
					data-testid="fv-body"
					onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
					className="flex-1 overflow-auto bg-surface px-5 py-2.5"
				>
					<div style={{ height: mdWindow.topSpacer }} />
					{visibleMdBlocks.map((bi) => (
						<div key={bi} data-md-block={bi}>
							<MarkdownPreview
								content={mdBlocks[bi].text}
								sessionId={sessionId ?? ""}
								baseDir={displayPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "") ?? ""}
							/>
						</div>
					))}
					<div style={{ height: mdWindow.bottomSpacer }} />
				</div>
				<PathBar path={displayPath} />
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full" data-testid="file-viewer">
			<div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface" data-modal-drag-handle="">
				<span className="text-[calc(12px*var(--font-scale))] text-secondary flex-1 truncate font-mono inline-flex items-center gap-1">
					<Icon name="file" size={12} /> {fileName}
				</span>
				<ShareButton
					paths={[resolvedPath ?? path]}
					sessionId={sessionId}
					className="fv-btn"
					testId="share-file-btn"
				/>
				<button
					className="fv-btn"
					onClick={copyContent}
					title={t("common.copy")}
					aria-label={t("common.copy")}
					data-testid="fv-copy-content"
				>
					<Icon name="clipboard" size={12} />
				</button>
				<button className="fv-btn" onClick={onClose} title={t("common.close")}>
					<Icon name="x" size={12} />
				</button>
			</div>
			<div
				ref={bodyRef}
				data-testid="fv-body"
				onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
				className="flex-1 overflow-auto bg-surface p-2.5"
			>
				{/* 上下占位撑出完整滚动高度（未渲染行数 × 行高），保证可滚动浏览全文 */}
				<div style={{ height: chunkWindow.topSpacer }} />
				{visibleChunks.map((ci) => {
					const start = ci * VIRTUAL_CHUNK_LINES;
					const chunkCode = allLines
						.slice(start, start + VIRTUAL_CHUNK_LINES)
						.join("\n");
					return (
						<Highlight
							key={ci}
							theme={isDark ? themes.nightOwl : themes.github}
							code={chunkCode}
							language={language}
						>
							{({ tokens, getLineProps, getTokenProps }) => (
								<pre className="text-[calc(12px*var(--font-scale))] font-mono m-0">
									<code>
										{tokens.map((line, i) => {
											const lineNo = start + i + 1;
											return (
												<div
													{...getLineProps({ line, key: i })}
													key={i}
													className="table-row"
													data-line={lineNo}
												>
													<span
														className="table-cell pr-3 text-right text-tertiary select-none"
														style={{ opacity: 0.6 }}
													>
														{lineNo}
													</span>
													<span className="table-cell whitespace-pre">
														{line.map((token, tKey) => (
															<span {...getTokenProps({ token, key: tKey })} key={tKey} />
														))}
													</span>
												</div>
											);
										})}
									</code>
								</pre>
							)}
						</Highlight>
					);
				})}
				<div style={{ height: chunkWindow.bottomSpacer }} />
			</div>
			<PathBar path={displayPath} />
		</div>
	);
}
