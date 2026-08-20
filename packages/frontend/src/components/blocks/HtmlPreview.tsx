import { buildPreviewUrl } from "../../preview-url";

/** iframe 渲染单个 html 文件（相对资源走同源 /preview 路由）。refreshKey 变化重挂载实现刷新。 */
export function HtmlPreview({
	path,
	refreshKey,
}: {
	path: string;
	refreshKey?: number;
}) {
	return (
		<iframe
			key={refreshKey}
			src={buildPreviewUrl(path)}
			sandbox="allow-scripts allow-modals"
			title="HTML preview"
			data-testid="html-preview-iframe"
			className="w-full h-full border-0 bg-white"
		/>
	);
}
