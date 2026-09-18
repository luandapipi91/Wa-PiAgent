import { memo, useMemo, useRef } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
import type { MediaItem } from "./media-utils";
import { useThrottledValue } from "./useThrottledValue";

/**
 * 全仓库**唯一**的 markdown 渲染组件。
 *
 * 统一前的 9 处渲染点（聊天正文、子代理流、Fleet 降级、FileViewer 预览、导出图、
 * 扩展弹窗、Ask 预览、回收站、死代码 TextBlock）各自内联 `ReactMarkdown` +
 * 自己的包装类/组件映射/节流逻辑，能力参差且改一处要改九处。现在全部走这里，
 * 差异收敛为 props：
 *
 * - `sessionId` + `interactive`：markdown 里的链接/图片/文件 chip/mermaid/代码卡片
 *   经会话内预览组件处理；只读或静态场景关掉 interactive 即退化为纯 markdown。
 * - `components`：在基础映射上覆盖（FileViewer 覆盖 img/a）或独占（Ask 预览只要 a）。
 * - `mediaItems`：图片画廊清单。**流式场景务必传 getter**——依赖漂移会让内联渲染函数
 *   每帧换新 type，整棵 markdown 树 remount（chip/图片闪烁的根因，契约见
 *   tests/blocks/markdown-streaming-stability.test.tsx）。
 * - `transformText`：入参前置整形（扩展弹窗的终端排版归一化、Fleet 的片段改写）。
 * - `streaming`/`throttleMs`：流式中始终渲染 markdown 但解析节流（不闪、不逐帧全量解析）。
 * - `className`/`testId`：包装与定位钩子。
 *
 * 刻意**不做**的事：聊天区的媒体段落拆分（把整段视频路径抽成 InlineVideo）发生在
 * ReactMarkdown 之外，属消息级处理；FileViewer 的块级虚拟滚动同理，都不该塞进来。
 */
type MarkdownPlugins = Options["remarkPlugins"];

export interface MarkdownProps {
	text: string;
	/** 会话上下文（链接/图片/文件 chip 走会话内预览）；静态场景可给占位串，默认空 */
	sessionId?: string;
	/** 是否挂载交互式组件（默认 true）；只读面板 / 导出截图传 false */
	interactive?: boolean;
	/** 组件映射：interactive 时与基础映射合并，否则独占 */
	components?: Components;
	/** 画廊清单；流式务必传 getter 保持引用稳定 */
	mediaItems?: MediaItem[] | (() => MediaItem[]);
	remarkPlugins?: MarkdownPlugins;
	/** 额外插件（如 FileViewer 的 rehypeRaw） */
	rehypePlugins?: MarkdownPlugins;
	urlTransform?: Options["urlTransform"];
	/** 入参前置整形（如 normalizeDialogText） */
	transformText?: (text: string) => string;
	/** 流式中：启用解析节流 */
	streaming?: boolean;
	throttleMs?: number;
	className?: string;
	/** 定位钩子；传 null 不加 data-testid */
	testId?: string | null;
}

export const Markdown = memo(function Markdown({
	text,
	sessionId = "",
	interactive = true,
	components,
	mediaItems,
	remarkPlugins,
	rehypePlugins,
	urlTransform,
	transformText,
	streaming = false,
	throttleMs = 50,
	className = "prose prose-sm max-w-none",
	testId = "text-block",
}: MarkdownProps) {
	// mediaItems 用 ref 中转：components 的 useMemo 依赖只能是 sessionId（见文件头契约）
	const mediaItemsRef = useRef(mediaItems);
	mediaItemsRef.current = mediaItems;
	const base = useMemo(
		() =>
			interactive
				? createMarkdownComponents(sessionId, () => {
						// prop 可以是数组，也可以是 getter（流式场景要的是「取值时才读最新清单」）
						const cur = mediaItemsRef.current;
						return typeof cur === "function" ? cur() : (cur ?? []);
					})
				: undefined,
		[interactive, sessionId],
	);
	const merged = useMemo(
		() => (base ? { ...base, ...components } : components),
		[base, components],
	);

	const displayText = useThrottledValue(text, streaming, throttleMs);
	const body = transformText ? transformText(displayText) : displayText;

	return (
		<div
			className={className}
			{...(testId ? { "data-testid": testId } : {})}
		>
			<ReactMarkdown
				remarkPlugins={remarkPlugins ?? [remarkGfm]}
				rehypePlugins={rehypePlugins}
				components={merged}
				urlTransform={urlTransform}
			>
				{body}
			</ReactMarkdown>
		</div>
	);
});
