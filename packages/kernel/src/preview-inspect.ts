/** inspect 脚本注入标签：/preview/*.html 响应注入，使本地预览获得元素选中能力 */
export const INSPECT_SCRIPT_TAG =
	'<script src="/preview-inspect.js"></script>';

/**
 * 大文件护栏（字节）：超过 10MB 的 html 不做注入/元素定位解析，
 * 避免整文件读入内存 + 全量正则扫描拖慢 /preview 与 /api/preview-locate。
 */
export const PREVIEW_PARSE_MAX_BYTES = 10 * 1024 * 1024;

/** 向 html 注入 inspect 脚本标签：优先插到 </head> 前，无 head 则插到最前 */
export function injectInspectScript(html: string): string {
	// 已知边界（低概率）：页面 JS 字符串/注释里含字面量 </head> 时，
	// 正则会命中该处而非真正的 head 结束标签，脚本可能注错位置
	const m = /<\/head\s*>/i.exec(html);
	if (m) return html.slice(0, m.index) + INSPECT_SCRIPT_TAG + html.slice(m.index);
	return INSPECT_SCRIPT_TAG + html;
}
