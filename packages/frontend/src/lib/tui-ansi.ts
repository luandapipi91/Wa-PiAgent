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
	for (const k of ATTR_KEYS) if (!!a[k] !== !!b[k]) return false;
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
			links.push({ text: stripOsc(text.slice(open.from, m.index)), url: open.url });
			open = null;
		}
	}
	return links;
}
