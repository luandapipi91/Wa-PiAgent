import type { Components } from "react-markdown";
import { Children, isValidElement } from "react";
import { CodeBlockCard } from "./CodeBlockCard";
import { MermaidBlock } from "./MermaidBlock";
import { FilePill } from "./FilePill";
import { mediaKindOf, parseFilePath } from "./file-path";
import { MarkdownImage } from "./MarkdownImage";
import { InlineVideo } from "./InlineVideo";
import { useSessionStore } from "../../store/session";
import { fileNameOf, type MediaItem } from "./media-utils";

// ⚠️ 循环依赖：FileViewer → markdown-components → FilePill → FileViewer。
// 约束：本模块顶层不得引用 FileViewer/FilePill 的模块级值（如初始化、常量推导）；
// 组件引用只在渲染期访问（JSX 内），函数声明提升 + 渲染期才求值保证安全。
// 新增代码时保持同样约束：不要在任何顶层作用域调用 FileViewer/FilePill。

/**
 * markdown 链接渲染：新标签页打开，避免 SPA 页面被外部链接替换；
 * 蓝色 + 下划线样式，让用户一眼看出可点击。
 * 导出供所有 ReactMarkdown 渲染点（聊天区 / fleet / delegate / ask 选项 preview）复用。
 */
export function MarkdownLink({ className, ...props }: any) {
	return (
		<a
			{...props}
			target="_blank"
			rel="noopener noreferrer"
			className={`text-accent underline underline-offset-2 hover:opacity-80 ${className ?? ""}`.trim()}
		/>
	);
}

/**
 * 行内代码内容是否为裸 http/https URL（trim 后整体匹配）。
 * 只允许 http/https 协议，拒绝 javascript: 等注入协议。
 * 用途：remark-gfm 的 autolink 不解析 code 构造内的文本，
 * AI 常用反引号包裹 URL，需在此补一层链接化。
 */
function isLinkText(text: string): boolean {
	const t = text.trim();
	return /^https?:\/\/\S+$/.test(t);
}

/**
 * 生成助手消息的 markdown 组件映射。
 * pre → CodeBlockCard / MermaidBlock；形似路径的内联 code → 媒体（图片卡片/视频播放器）或 FilePill（块级 code 已被 pre 接管，不会走到这里）；a → 新标签页打开。
 * img → MarkdownImage 卡片缩略图；p → 同段落连续 ≥2 张图片聚合为 2 列网格（>4 张第 4 张叠「+N」）。
 * mediaItems：该文本块内全部媒体（collectMediaItems 收集），供点击打开画廊时传完整清单。
 * 传数组或返回数组的 getter 均可：流式场景传 getter（如 () => ref.current），
 * 让 components 的 useMemo 依赖不随清单每帧变化——否则内联渲染函数 type 每帧变化，
 * React 会整树 remount，chip/图片/视频全部闪烁。
 */
export function createMarkdownComponents(
	sessionId: string,
	mediaItems: MediaItem[] | (() => MediaItem[]) = [],
): Components {
	/** 事件/渲染时求值最新清单：getter 形态下每次点击拿到的都是当前帧的完整画廊 */
	const resolveItems = (): MediaItem[] =>
		typeof mediaItems === "function" ? mediaItems() : mediaItems;
	const imgRenderer = (props: any) => (
		<MarkdownImage
			src={props.src}
			alt={props.alt}
			sessionId={sessionId}
			items={resolveItems()}
		/>
	);
	return {
		a: MarkdownLink,
		img: imgRenderer,
		p: (props: any) => {
			// 连续图片段落：同一 markdown 段落内多个 img（行间仅空白文本节点）→ 2 列网格。
			// 引用比较 k.type === imgRenderer 判定子节点是本模块图片（react-markdown 直接以
			// 映射组件为元素类型）；FileViewer 的 MarkdownPreview 覆盖了 img → 不命中、不聚合。
			const kids = Children.toArray(props.children).filter(
				(c) => !(typeof c === "string" && c.trim() === ""),
			);
			if (
				kids.length >= 2 &&
				kids.every((k) => isValidElement(k) && k.type === imgRenderer)
			) {
				const shown = kids.slice(0, 4);
				const extra = kids.length - shown.length;
				return (
					<div className="grid grid-cols-2 gap-2 my-1" data-testid="md-image-grid">
						{shown.map((k, i) => {
							if (i === 3 && extra > 0) {
								const src = (k as any).props.src as string | undefined;
								const norm = src?.replace(/\\/g, "/");
								const idx = resolveItems().findIndex(
									(it) => it.src === norm && it.kind === "image",
								);
								return (
									<div key={i} className="relative">
										{k}
										<button
											type="button"
											data-testid="md-image-more"
											onClick={() =>
												useSessionStore
													.getState()
													.openMediaPreview(resolveItems(), Math.max(idx, 0), sessionId)
											}
											className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-white text-[calc(18px*var(--font-scale))] font-semibold cursor-pointer"
										>
											+{extra}
										</button>
									</div>
								);
							}
							return k;
						})}
					</div>
				);
			}
			return <p>{props.children}</p>;
		},
		pre: (props: any) => {
			const codeEl = props.children;
			const className: string = codeEl?.props?.className ?? "";
			const m = /language-([\w+-]+)/.exec(className);
			const code = String(codeEl?.props?.children ?? "");
			// mermaid 代码块用 MermaidBlock 渲染为可视图表
			if (m?.[1] === "mermaid") {
				return <MermaidBlock code={code} />;
			}
			return <CodeBlockCard language={m?.[1] ?? ""} code={code} />;
		},
		code: (props: any) => {
			const text = String(props.children ?? "");
			const parsed = !props.className ? parseFilePath(text) : null;
			if (parsed) {
				// 媒体路径芯片直接渲染为缩略图/内联播放器（模型常用表格+行内代码列路径）
				const kind = mediaKindOf(parsed.path);
				if (kind === "image") {
					return (
						<MarkdownImage
							src={parsed.path}
							sessionId={sessionId}
							items={resolveItems()}
						/>
					);
				}
				if (kind === "video") {
					return (
						<InlineVideo
							src={parsed.path}
							name={fileNameOf(parsed.path)}
							sessionId={sessionId}
							items={resolveItems()}
						/>
					);
				}
				return (
					<FilePill
						rawText={text}
						sessionId={sessionId}
						mediaItems={resolveItems()}
					/>
				);
			}
			// 反引号包裹的裸 URL：渲染为可点击链接（autolink 不进入 code 构造）
			if (!props.className && isLinkText(text)) {
				return <MarkdownLink href={text.trim()}>{text}</MarkdownLink>;
			}
			return <code>{props.children}</code>;
		},
	};
}
