/**
 * 扩展弹窗（ExtensionDialog）正文归一化：把 pi 的**终端排版**还原成 markdown 结构。
 *
 * 背景：pi 的对话框正文常是终端画出来的。pi-goal-x 的 `extensions/goal-draft.ts:34`
 * （formatPrefixedLines）会给目标正文的每一行加 `│   ` 前缀，分节线写成 `─── X ───`，
 * 任务区是 `┌─ TASKS ─┐ … └─┘` 方框。原样交给 markdown 解析器时，被 `│   ` 挡住的
 * 表格分隔行 / 清单 / 标题全都解析不出来——用户看到的就是「表格没渲染出来」。
 *
 * 只在**行首/行尾**动框线字符（U+2502 `│` 一类），不碰 ASCII 竖线 `|`
 * （markdown 表格用的正是它）。无法识别为装饰的行一律原样保留。
 */

/** 行首的框线前缀：`│` 或 `┃` + 空白 */
const LEADING_RULE_RE = /^\s*[│┃]\s*/;
/** 行尾的框线：空白 + `│` 或 `┃` */
const TRAILING_RULE_RE = /\s*[│┃]\s*$/;
/** 装饰线字符（不含 ASCII `-` / `|`，避免误伤 markdown 本身） */
const RULE_CHARS = "─═┌├└┐┘┤━┃";
/** 分节行：装饰线 + 标题 + 装饰线，如 `─── Draft Details ───`、`=== Goal ===`、`┌─ TASKS ─┐` */
const SECTION_RE = new RegExp(
	`^[\\s${RULE_CHARS}]*[─═=]{1,}\\s*(.+?)\\s*[─═=]{1,}[\\s${RULE_CHARS}]*$`,
);
/** 纯装饰行（没有标题）：整行只有框线/等号，GUI 里没有意义 */
const DECORATION_ONLY_RE = new RegExp(`^[\\s${RULE_CHARS}=]*[─═=]{4,}[\\s${RULE_CHARS}=]*$`);

/** 小标题行（归一化产物）：`### X` */
const HEADING_RE = /^\s*#{1,6}\s+\S/;
/** 表格分隔行：`| --- | --- |` / `|:--:|` */
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/** 表格行：`| a | b |` 或分隔行 */
const TABLE_ROW_RE = /^\s*\|/;

/** 其它块级结构的起始行（清单 / 引用 / 围栏代码） */
const BLOCK_START_RE = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|>|```)/;

/**
 * 这一行是否需要「另起一块」：pi-goal-x 的 formatPrefixedLines 会把目标里的空行整行丢掉
 * （`if (!trimmed) continue`），表格 / 清单因此紧贴上一段文字，markdown 就认不出来了。
 * 只在块级结构前补空行，普通换行不动。
 */
function isTableLine(line: string): boolean {
	return TABLE_ROW_RE.test(line) || TABLE_DELIMITER_RE.test(line);
}

function needsBlockBreak(line: string, next: string | undefined): boolean {
	// 小标题不需要（ATX 标题本来就能打断段落，且空白由上面的收紧规则管）
	if (HEADING_RE.test(line)) return false;
	if (BLOCK_START_RE.test(line)) return true;
	if (/^\s*\|/.test(line) && next !== undefined && TABLE_DELIMITER_RE.test(next)) {
		return true;
	}
	return false;
}

/**
 * 把终端排版的对话框文本还原成 markdown；识别不出装饰时原样返回。
 *
 * 另外收紧空白：源里的连续空行会被 `pre-wrap` 当真空白行画出来，再叠加 markdown 的
 * 段落外边距就是一大片空（用户看到的就是「空得不成样子」）。所以连续空行压成一个、
 * 小标题两侧不留空行（标题自带外边距），但**表格前的空行要保留**——markdown 表格
 * 必须另起一块才算表格。
 */
export function normalizeDialogText(text: string): string {
	const lines = text.split("\n").map((rawLine) => normalizeLine(rawLine));
	return collapseBlankLines(lines).join("\n");
}

/** 压空白：连续空行→一个；小标题前后不留空行；首尾空白行去掉 */
function collapseBlankLines(lines: string[]): string[] {
	const isBlank = (l: string | undefined) => (l ?? "").trim() === "";
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (isBlank(line)) {
			const next = lines.slice(i + 1).find((l) => !isBlank(l));
			const prev = kept[kept.length - 1];
			// 上一行是小标题 / 下一个非空行是小标题 → 这个空行不要
			if (prev === undefined || HEADING_RE.test(prev)) continue;
			if (next !== undefined && HEADING_RE.test(next)) continue;
			// 表格前的空行保留；表头行与表格数据行之间本来也没有空行
			if (kept[kept.length - 1] === "") continue;
			kept.push("");
			continue;
		}
		// 块级结构前补一个空行（上一行不是空行时）
		if (
			kept.length > 0 &&
			kept[kept.length - 1] !== "" &&
			needsBlockBreak(line, lines[i + 1])
		) {
			kept.push("");
		}
		// 表格结束后补一个空行：gfm 表格只被空行/块级结构打断，
		// 紧随其后的正文否则会被当成表格行吞进去
		const prev = kept[kept.length - 1];
		if (
			prev !== undefined &&
			prev !== "" &&
			isTableLine(prev) &&
			!isTableLine(line) &&
			!HEADING_RE.test(line)
		) {
			kept.push("");
		}
		kept.push(line);
	}
	while (kept.length && kept[kept.length - 1] === "") kept.pop();
	return kept;
}

function normalizeLine(rawLine: string): string {
	const stripped = rawLine
		.replace(LEADING_RULE_RE, "")
		.replace(TRAILING_RULE_RE, "");
	// 纯装饰线（含去掉边之后只剩线的方框行）直接丢掉
	if (DECORATION_ONLY_RE.test(stripped) || DECORATION_ONLY_RE.test(rawLine)) {
		return "";
	}
	const section = SECTION_RE.exec(stripped);
	if (section?.[1]) {
		const title = section[1].replaceAll(/[│┃]/g, "").trim();
		if (title) return `### ${title}`;
	}
	// 无框线可去、也不是分节线：原样保留（普通正文/正常 markdown）
	if (stripped === rawLine) return rawLine;
	return stripped;
}
