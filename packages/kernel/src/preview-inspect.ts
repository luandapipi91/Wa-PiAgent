/** inspect 脚本注入标签：/preview/*.html 响应注入，使本地预览获得元素选中能力 */
export const INSPECT_SCRIPT_TAG = '<script src="/preview-inspect.js"></script>';

/**
 * srcdoc 属性内联内容的转义态脚本标签：srcdoc 型 iframe 内容内联在属性里、
 * 不发 HTTP 请求，kernel 无法经 /preview 路由注入；且外层预览页跑在 sandbox
 * 不透明源下时，父层 contentDocument 被阻断、无法运行时代注入 —— 唯一可控的
 * 注入面就是外层 HTML 文本本身。直接在转义态上操作：找转义的 </head>，
 * 在其前插入转义脚本；无 head 则插到属性值最前。
 */
const SRCDOC_SCRIPT_DQ =
	"&lt;script src=&quot;/preview-inspect.js&quot;&gt;&lt;/script&gt;";
const SRCDOC_SCRIPT_SQ =
	"&lt;script src=&#39;/preview-inspect.js&#39;&gt;&lt;/script&gt;";

/** 转义态 srcdoc 内容注入（不解码/再编码，避免实体边界问题）；quote 决定内部引号转义形态 */
function injectIntoSrcdoc(escaped: string, quote: '"' | "'"): string {
	const script = quote === '"' ? SRCDOC_SCRIPT_DQ : SRCDOC_SCRIPT_SQ;
	// 转义态 </head>：&lt;/head&gt;（允许尾部空白 &lt;/head &gt; 的形态一并兼容）
	const m = /&lt;\/head\s*&gt;/i.exec(escaped);
	if (m) return escaped.slice(0, m.index) + script + escaped.slice(m.index);
	return script + escaped;
}

/**
 * 大文件护栏（字节）：超过 10MB 的 html 不做注入/元素定位解析，
 * 避免整文件读入内存 + 全量正则扫描拖慢 /preview 与 /api/preview-locate。
 */
export const PREVIEW_PARSE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 向 html 注入 inspect 脚本标签：
 * ① 文档级：优先插到 </head> 前，无 head 则插到最前；
 * ② srcdoc 型 iframe：属性值内同样注入（转义态），嵌套原型（如 srcdoc 预览）
 *    在 sandbox 不透明源下也能获得元素选中能力。
 * 已知边界（低概率）：页面 JS 字符串/注释里含字面量 </head> 或 srcdoc="...") 时，
 * 正则会命中该处而非真实标签，脚本可能注错位置（运行时防御脚本自身无害）。
 */
export function injectInspectScript(html: string): string {
	// 已知边界（低概率）：页面 JS 字符串/注释里含字面量 </head> 时，
	// 正则会命中该处而非真正的 head 结束标签，脚本可能注错位置
	const m = /<\/head\s*>/i.exec(html);
	const docLevel =
		m === null
			? INSPECT_SCRIPT_TAG + html
			: html.slice(0, m.index) + INSPECT_SCRIPT_TAG + html.slice(m.index);
	// srcdoc 属性：双引号形态（值内不含裸 "，实体转义为 &quot;）与单引号形态各扫一遍；
	// 值内已是转义文本，直接在转义态上插脚本，不做解码往返
	return docLevel
		.replace(/srcdoc="([^"]*)"/gi, (attr, body: string) =>
			body.includes(SRCDOC_SCRIPT_DQ)
				? attr
				: `srcdoc="${injectIntoSrcdoc(body, '"')}"`,
		)
		.replace(/srcdoc='([^']*)'/gi, (attr, body: string) =>
			body.includes(SRCDOC_SCRIPT_SQ)
				? attr
				: `srcdoc='${injectIntoSrcdoc(body, "'")}'`,
		);
}
