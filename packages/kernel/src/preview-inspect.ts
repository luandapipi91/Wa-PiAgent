/** inspect 脚本注入标签：/preview/*.html 响应注入，使本地预览获得元素选中能力 */
export const INSPECT_SCRIPT_TAG =
	'<script src="/preview-inspect.js"></script>';

/** 向 html 注入 inspect 脚本标签：优先插到 </head> 前，无 head 则插到最前 */
export function injectInspectScript(html: string): string {
	const m = /<\/head\s*>/i.exec(html);
	if (m) return html.slice(0, m.index) + INSPECT_SCRIPT_TAG + html.slice(m.index);
	return INSPECT_SCRIPT_TAG + html;
}
