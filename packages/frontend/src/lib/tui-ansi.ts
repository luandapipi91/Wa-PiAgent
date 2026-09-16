/**
 * 终端 ANSI / OSC 纯函数：非颜色 SGR 属性、OSC 序列剥离、OSC 8 链接抽取。
 *
 * 与 `components/ui/AnsiText.tsx` 的分工：
 * - AnsiText 负责**颜色**（16 / 256 / truecolor 的 fg、bg）；
 * - 本模块负责**非颜色属性**（粗体 / 暗 / 斜体 / 下划线 / 反显）与 OSC 系列。
 *   `applySgrCodes` 只认属性码，颜色码一律忽略，两边不重复实现同一件事。
 */
export interface SgrAttrs {
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
}

export interface SgrSpan {
	text: string;
	attrs: SgrAttrs;
}

/** CSI 序列：`ESC [ 参数 终止字节`（SGR 的终止字节是 `m`） */
const CSI_RE = /\u001b\[([0-9;?]*)([A-Za-z])/g;
/** OSC 序列：`ESC ] payload BEL` 或 `ESC ] payload ESC \`（捕获组 1 是 payload） */
const OSC_RE = /\u001b\]([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

const ATTR_KEYS = ["bold", "dim", "italic", "underline", "inverse"] as const;

/**
 * 把 SGR 码作用到属性快照上（只处理非颜色码）。
 *
 * 0 是「全部重置」而非「停止解析」：`ESC[0;1m` 应当是「重置后加粗」，
 * 因此 0 之后的码继续生效。
 */
export function applySgrCodes(attrs: SgrAttrs, codes: number[]): SgrAttrs {
	const next: SgrAttrs = { ...attrs };
	for (const code of codes) {
		if (code === 0) for (const k of ATTR_KEYS) delete next[k];
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 7) next.inverse = true;
		else if (code === 22) {
			delete next.bold;
			delete next.dim;
		} else if (code === 23) delete next.italic;
		else if (code === 24) delete next.underline;
		else if (code === 27) delete next.inverse;
		/* 颜色（30-37/38/39/40-47/48/49）由 AnsiText 处理，这里刻意不收 */
	}
	return next;
}

function sameAttrs(a: SgrAttrs, b: SgrAttrs): boolean {
	for (const k of ATTR_KEYS) {
		const av = a[k] === true;
		const bv = b[k] === true;
		if (av !== bv) return false;
	}
	return true;
}

/**
 * 把一行拆成带属性的文本段。
 *
 * 非 SGR 的 CSI（光标移动、清屏等）整段丢弃，不外泄到文本；属性相同的相邻段合并，
 * 因此剥掉 `ESC[2K` 这类序列后不产生多余分段。
 *
 * 空参数的 `ESC[m` 按 ANSI 语义当作 0（重置）。
 */
export function parseSgrSpans(line: string): SgrSpan[] {
	const spans: SgrSpan[] = [];
	if (!line.includes("\u001b[")) {
		return line.length > 0 ? [{ text: line, attrs: {} }] : [];
	}

	let attrs: SgrAttrs = {};
	let last = 0;

	const push = (text: string, snapshot: SgrAttrs) => {
		if (text.length === 0) return;
		const prev = spans[spans.length - 1];
		if (prev && sameAttrs(prev.attrs, snapshot)) prev.text += text;
		else spans.push({ text, attrs: { ...snapshot } });
	};

	for (const m of line.matchAll(CSI_RE)) {
		if (m.index > last) push(line.slice(last, m.index), attrs);
		if (m[2] === "m") {
			const codes = (m[1] ?? "")
				.split(";")
				.filter((s) => s.length > 0)
				.map((s) => Number.parseInt(s, 10))
				.filter((n) => Number.isFinite(n));
			attrs = applySgrCodes(attrs, codes.length > 0 ? codes : [0]);
		}
		last = m.index + m[0].length;
	}
	if (last < line.length) push(line.slice(last), attrs);
	return spans;
}

/**
 * 剥掉所有 OSC 序列**标记**。
 *
 * - OSC 8（超链接）的可见文本位于开 / 闭标记**之外**，所以标记一剥、文本自然保留；
 *   链接的 url 与文本对应关系由 `takeLinks` 负责抽取，本函数不管。
 * - OSC 52（剪贴板）等序列的 payload 在标记**之内**，随标记一并删除。
 *
 * 即：这里的取舍是「保留可见文本、丢弃控制信息」。
 */
export function stripOsc(text: string): string {
	if (!text.includes("\u001b]")) return text;
	return text.replace(OSC_RE, "");
}

/**
 * 抽取 OSC 8 链接的可见文本与 URL，供组件渲染成可点元素。
 *
 * 只认成对的 `ESC]8;;<url>BEL ... ESC]8;;BEL`：开标记的 url 非空，闭标记 url 为空。
 * 取回的 `text` 是标记之间的**可见文本**（内部若混入其它 OSC，一并借 `stripOsc` 剥掉）；
 * 未闭合的链接忽略（面板帧可能被行边界切断）。
 */
export function takeLinks(text: string): Array<{ text: string; url: string }> {
	const links: Array<{ text: string; url: string }> = [];
	if (!text.includes("\u001b]8;")) return links;

	let open: { url: string; from: number } | null = null;
	for (const m of text.matchAll(OSC_RE)) {
		const payload = m[1] ?? "";
		if (!payload.startsWith("8;")) continue; // 非 OSC 8（如 OSC 52）与链接无关
		const url = payload.split(";").slice(2).join(";"); // payload = 8 ; params ; url
		if (url) {
			open = { url, from: m.index + m[0].length };
		} else if (open) {
			links.push({
				text: stripOsc(text.slice(open.from, m.index)),
				url: open.url,
			});
			open = null;
		}
	}
	return links;
}

/**
 * 终端语义下占**两格**的字符（East Asian Wide / Fullwidth 的常用区段）。
 *
 * 为什么需要它：浏览器里全角字符的前进宽由回退字体决定（JetBrains Mono 没有汉字，
 * 会落到 MiSans 之类的 CJK 字体上，前进宽 ≈ 1em ≈ 1.67 格），而 pi-tui 的 `visibleWidth`
 * 按两格排版。不校正就会让含中文的帧行整体错位（帧行里的 `cursor.col` 也按两格算）。
 *
 * 取舍：只认明确为 Wide/Fullwidth 的区段，East Asian **Ambiguous**（`▸ ○ · — €` 等）
 * 与 emoji 一律算一格——反向多判会把本来按一格排的字符撑开，比漏判更糟。
 * 已知局限：emoji（终端算 2 格）在这里按 1 格处理，含 emoji 的行仍会偏 1 格。
 * 与 `visibleWidth` 的另一处差异：这里按码点判断，不处理组合字素/零宽字符。
 */
export function isWideChar(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) || // 谚文字母
		(codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK 部首、康熙部首、CJK 符号与标点（含 U+3000 全角空格）
		(codePoint >= 0x3041 && codePoint <= 0x33ff) || // 假名、注音、谚文兼容字母、CJK 兼容、方块单位
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一表意文字
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) || // 彝文
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 谚文音节
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意文字
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) || // 竖排形式
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK 兼容形式、小写变体
		(codePoint >= 0xff01 && codePoint <= 0xff60) || // 全角 ASCII 变体
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) || // 全角货币符号
		(codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK 扩展 B 及以后（代理对）
	);
}

/**
 * 按「全角 / 半角」把文本切成片段（全角片段每字符占 2 格，半角每字符占 1 格）。
 *
 * 用 `for...of` 迭代码点，代理对（扩展 B 及以后的汉字）不会被拆成两个半字符。
 * 调用方据片段顺序拼接：全角片段要按字符包固定宽度的行内块，半角片段原样输出。
 */
export function splitByCellWidth(
	text: string,
): Array<{ text: string; wide: boolean }> {
	const runs: Array<{ text: string; wide: boolean }> = [];
	let buffer = "";
	let wide = false;
	for (const ch of text) {
		const isWide = isWideChar(ch.codePointAt(0) ?? 0);
		if (buffer && isWide !== wide) {
			runs.push({ text: buffer, wide });
			buffer = "";
		}
		wide = isWide;
		buffer += ch;
	}
	if (buffer) runs.push({ text: buffer, wide });
	return runs;
}
