// ExportImageCard — 聊天导出图片的专用排版组件（屏外渲染后转 PNG）。
// 独立分享排版：用户右气泡（纯文本）+ AI 左回复（markdown）+ 底部署名；
// 不含思考/工具等过程卡片，不含聊天窗装饰。Tailwind 类与主题变量可用——
// 节点渲染在真实文档中（屏外定位），html-to-image 负责内联计算样式与字体。
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
import type { ExportTurn } from "../../util/export-chat-image";

interface Props {
	turns: ExportTurn[];
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ExportImageCard({ turns }: Props) {
	// "export" 是占位 sessionId：FilePill 等交互组件在图片里只是静态样式
	const mdComponents = useMemo(() => createMarkdownComponents("export"), []);
	return (
		<div
			data-testid="export-image-card"
			className="bg-canvas text-primary"
			style={{ width: 640, padding: 24, fontFamily: '"MiSans", system-ui, sans-serif' }}
		>
			{turns.map((t, i) => (
				<div key={i} className="flex flex-col gap-2 mb-5">
					{/* 用户消息：靠右气泡，纯文本不渲染 markdown。
					    extension 命令等无 user 消息的轮次 user 为空，不渲染空气泡。 */}
					{t.user && (
						<div className="flex justify-end">
							<div
								className="max-w-[80%] px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap bg-accent-soft text-primary"
								style={{ lineHeight: 1.55, borderRadius: "14px 4px 14px 14px" }}
							>
								{t.user}
							</div>
						</div>
					)}
					{/* AI 回复：靠左，markdown 渲染 */}
					<div>
						<div className="text-[11px] text-tertiary font-semibold mb-0.5">
							{t.agentName} · {formatTime(t.timestamp)}
						</div>
						<div
							className="prose prose-sm max-w-none text-[13.5px]"
							style={{ lineHeight: 1.55 }}
						>
							<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
								{t.assistant}
							</ReactMarkdown>
						</div>
					</div>
				</div>
			))}
			<div className="border-t border-hairline pt-2 mt-1 text-center text-[11px] text-tertiary">
				WA PI Agent
			</div>
		</div>
	);
}
