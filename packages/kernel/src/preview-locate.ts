/**
 * 静态解析 html，按 selector（" > " 路径，段为 tag / tag#id / tag:nth-of-type(n)）
 * 定位元素在源文件中的起止行号。不执行页面：JS 动态生成的元素定位不到，返回 null。
 * 段生成规则与前端 inspect 脚本 buildSelector 严格一致：
 * - 有 id → `tag#id`；否则 → `tag:nth-of-type(n)`（n 为同标签兄弟序号，从 1 起）
 * - 根元素（无父级，即 <html>）→ 裸 tag（body 有父元素，不特判，用 nth 形式）
 *
 * 已知限制（V1 接受，不补规则）：浏览器会隐式闭合的 HTML（如 `<p>one<p>two`、
 * `<li>` 省略闭合）本解析器按字面嵌套处理，nth 计数与真实 DOM 不一致，定位返回
 * null——前端 chip 降级为无行号展示，不影响主流程。另：无闭合 `</script>` 的
 * 残缺文件内容不抹除，同为已知边界。
 */

const VOID_TAGS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr",
]);

export interface ElementLocation {
	startLine: number;
	endLine: number;
}

interface ElRecord {
	path: string[];
	startLine: number;
	endLine: number;
}

interface Frame {
	tag: string;
	rec: ElRecord;
	/** 该元素已扫描子元素的同标签计数（算 nth-of-type 用） */
	counts: Map<string, number>;
}

export function locateElement(
	html: string,
	selector: string,
): ElementLocation | null {
	const segs = selector
		.split(" > ")
		.map((s) => s.trim())
		.filter(Boolean);
	if (segs.length === 0) return null;

	// script/style 内容整体抹掉（保留换行，行号不变），避免 JS 字符串里的假标签干扰
	const cleaned = html.replace(
		/<(script|style)\b[\s\S]*?<\/\1\s*>/gi,
		(m) => m.replace(/[^\n]/g, " "),
	);

	// 行号索引：每个 \n 的位置 + 1 即下一行起点
	const lineStarts = [0];
	for (let i = 0; i < cleaned.length; i++) {
		if (cleaned[i] === "\n") lineStarts.push(i + 1);
	}
	const lineOf = (idx: number): number => {
		let lo = 0, hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= idx) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};

	const records: ElRecord[] = [];
	const stack: Frame[] = [];
	const rootCounts = new Map<string, number>();
	const tagRe =
		/<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;

	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(cleaned))) {
		if (!m[2]) continue; // 注释 / doctype
		const tag = m[2].toLowerCase();
		const line = lineOf(m.index);

		if (m[1] === "/") {
			// 闭合标签：弹栈到最近匹配（容忍未闭合嵌套，如 <p> 省略闭合）
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].tag === tag) {
					for (let j = stack.length - 1; j >= i; j--) {
						stack[j].rec.endLine = line;
					}
					stack.length = i;
					break;
				}
			}
			continue;
		}

		const attrs = m[3] ?? "";
		const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
		const parentCounts = stack.length > 0 ? stack[stack.length - 1].counts : rootCounts;
		const nth = (parentCounts.get(tag) ?? 0) + 1;
		parentCounts.set(tag, nth);
		const seg =
			stack.length === 0 ? tag : id ? `${tag}#${id}` : `${tag}:nth-of-type(${nth})`;
		const parentPath = stack.length > 0 ? stack[stack.length - 1].rec.path : [];
		const rec: ElRecord = { path: [...parentPath, seg], startLine: line, endLine: line };
		records.push(rec);
		if (!VOID_TAGS.has(tag) && m[4] !== "/") {
			stack.push({ tag, rec, counts: new Map() });
		}
	}

	// 路径全等匹配（两侧段生成规则一致，直接字符串比较）
	for (const rec of records) {
		if (rec.path.length !== segs.length) continue;
		if (rec.path.every((s, i) => s === segs[i])) {
			return { startLine: rec.startLine, endLine: rec.endLine };
		}
	}
	return null;
}
