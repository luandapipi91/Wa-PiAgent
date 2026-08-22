import { forwardRef } from "react";
import { buildPreviewUrl } from "../../preview-url";

type HtmlPreviewProps = { refreshKey?: number } & (
	| { path: string; externalUrl?: never }
	| { path?: never; externalUrl: string }
);

/**
 * iframe 渲染页面：
 * - path：本地 html 文件（相对资源走同源 /preview 路由，sandbox 独特源隔离）
 * - externalUrl：外部站点（直接加载，sandbox 放开 allow-same-origin/allow-popups
 *   让其以自己的源运行、可开新标签；受对方站点 X-Frame-Options/CSP 限制）
 * refreshKey 变化重挂载实现刷新。
 * ref 暴露 iframe 元素：父级（BrowserPanel）校验 inspect postMessage 的 source 用。
 */
export const HtmlPreview = forwardRef<HTMLIFrameElement, HtmlPreviewProps>(
	function HtmlPreview({ path, externalUrl, refreshKey }, ref) {
		const src = externalUrl ?? buildPreviewUrl(path!);
		const sandbox = externalUrl
			? "allow-scripts allow-same-origin allow-popups allow-modals"
			: "allow-scripts allow-modals";
		return (
			<iframe
				key={refreshKey}
				ref={ref}
				src={src}
				sandbox={sandbox}
				title="HTML preview"
				data-testid="html-preview-iframe"
				className="w-full h-full border-0 bg-white"
			/>
		);
	},
);
