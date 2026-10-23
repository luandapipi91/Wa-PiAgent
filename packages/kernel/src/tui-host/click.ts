import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * 点击回退：把「点在某一行上」翻译成等价的键盘序列。
 *
 * 为什么需要它：pi-tui 的鼠标分发只对实现了 `handleMouse` 的组件生效
 * （`dispatchMouseEvent`：`component.handleMouse?.(event)`）。自定义对话框——
 * 例如 pi-goal-x 的 goal-questionnaire（提案确认/问卷）——只实现 `handleInput`，
 * 于是鼠标按下会一路落到 alt-screen 的文本选择逻辑，用户点选项行等于没反应。
 * 真终端里是同样的表现：这不是 wa-pi 的通道断链，而是末端组件没实现鼠标。
 *
 * 因此宿主在**组件未消费鼠标**时做一次保守的推断：对话框自己在帧里声明了
 * 「Enter select」，选项行也带编号与选中标记，据此把点击换算成 ↑↓ + Enter。
 * 任何一条证据缺失都返回 null（保持原行为，宁可点不动也不要乱按键）。
 *
 * 纯函数：输入帧行 + 行下标，输出要注入的按键序列（**逐键**——真终端的
 * StdinBuffer 是一次一个序列派发的，拼成一串会让 `matchesKey` 解析不出任何键）。
 */

/** 选项行：编号 + 至少一个非空白字符（前导可有选中标记 > 或 ❯/›） */
const OPTION_RE = /^[ \t]{0,6}(?:[>❯›][ \t]+)?(\d+)\.[ \t]+\S/;
/** 选中项标记（pi-tui / pi-goal-x 都用它表示当前光标所在项） */
const SELECTED_OPTION_RE = /^[ \t]{0,6}[>❯›][ \t]+\d+\.[ \t]+\S/;
/** 对话框自报的可点击提示，如 " (press 'a' to toggle)" */
const TOGGLE_HINT_RE = /\(press '([A-Za-z0-9])' to toggle\)/;
/** 对话框自报的回车语义（没有它就不敢按下回车） */
const ENTER_HINT_RE = /Enter[ \t]+(?:to[ \t]+)?(?:select|confirm|submit)/i;

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_ENTER = "\r";

interface OptionRow {
	row: number;
	num: number;
}

/**
 * 解析点击目标行，返回等价的按键序列（逐键，按先后顺序）；无法确定时返回 null。
 *
 * @param lines 帧行（含 ANSI；本函数自行剥离）
 * @param row   被点击的**组件内行下标**（0-based）
 */
export function resolveClickKeys(lines: string[], row: number): string[] | null {
	if (!Number.isInteger(row) || row < 0 || row >= lines.length) return null;

	const plain = lines.map((line) => stripTerminalSequences(line ?? ""));
	const target = plain[row];
	if (target === undefined) return null;

	// 1. 对话框自己写了「按 X 切换」——照它说的发，最没有歧义
	const toggle = TOGGLE_HINT_RE.exec(target);
	if (toggle?.[1]) return [toggle[1]];

	// 2. 回车语义必须以对话框自己的提示为准（没提示的面板不猜）
	const footer = lastIndexMatching(plain, ENTER_HINT_RE);
	if (footer < 0) return null;

	// 3. 选项块：从底部往上取「编号连续递减」的那一段——
	//    正文里凑巧写了「1. xxx」的清单行会因为编号接不上而被自然排除
	const block = optionBlockBelow(plain, footer);
	if (!block.length) return null;

	const selected = block.find(
		(opt) => SELECTED_OPTION_RE.test(plain[opt.row] ?? ""),
	);
	if (!selected) return null;

	// 4. 点击行必须是选项块内的一项；折行的续行归到它上面最近的那个选项
	const hit = optionHitAt(plain, row, block, footer);
	if (hit === null) return null;

	const delta = hit - selected.num;
	const keys = delta > 0 ? Array.from({ length: delta }, () => KEY_DOWN) : Array.from({ length: -delta }, () => KEY_UP);
	return [...keys, KEY_ENTER];
}

/** 帧里最后一个匹配的行下标；没有则 -1 */
function lastIndexMatching(lines: string[], re: RegExp): number {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (re.test(lines[i] ?? "")) return i;
	}
	return -1;
}

/**
 * 取底部提示行之上的选项块：从最后一条编号行起往上，编号必须逐个减一。
 * 必须自成 1..N 才成立（否则说明这些「编号行」不是同一份选项列表）。
 */
function optionBlockBelow(plain: string[], footer: number): OptionRow[] {
	const rows: OptionRow[] = [];
	for (let i = 0; i < footer; i++) {
		const m = OPTION_RE.exec(plain[i] ?? "");
		if (m?.[1]) rows.push({ row: i, num: Number.parseInt(m[1], 10) });
	}
	if (!rows.length) return [];

	const block: OptionRow[] = [];
	let expected = rows[rows.length - 1]!.num;
	for (let i = rows.length - 1; i >= 0; i--) {
		const candidate = rows[i]!;
		if (candidate.num !== expected) break;
		block.unshift(candidate);
		expected -= 1;
	}
	// 编号必须从 1 开始（从底部倒推能推到 1 才算完整列表）
	return expected === 0 ? block : [];
}

/** 点击行对应的选项编号；不在选项块范围内返回 null */
function optionHitAt(
	plain: string[],
	row: number,
	block: OptionRow[],
	footer: number,
): number | null {
	const first = block[0]!.row;
	if (row < first || row >= footer) return null;

	const direct = OPTION_RE.exec(plain[row] ?? "");
	if (direct?.[1]) {
		const num = Number.parseInt(direct[1], 10);
		return block.some((opt) => opt.num === num && opt.row === row) ? num : null;
	}

	// 折行续行：归属到上方最近的一个选项行，但中间不许夹空行——
	// 否则点选项块里的空行/分隔行也会命中上面那个选项，等于「没点按钮却按了回车」
	for (let i = row; i >= first; i--) {
		const opt = block.find((o) => o.row === i);
		if (opt) return opt.num;
		if ((plain[i] ?? "").trim().length === 0) return null;
	}
	return null;
}

/** SGR 鼠标序列（前端 lib/tui-keys.ts 的 encodeMouse / encodeWheel 产物） */
const SGR_MOUSE_RE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * 帧行 → 终端视口行（SGR 鼠标序列改写）。
 *
 * 前端发的是**帧行**——用户点的就是画面上那一行，与它在面板里滚到哪儿无关；而 pi-tui
 * 的 SGR 坐标是**终端屏幕行**：宿主把内容放进 alt-screen 的隐式滚动视图，视口停在底部，
 * 偏移 = max(0, 帧行数 - 终端行数)。不折算就会「点 2 中 3」——浏览器里文本区高度往往
 * 不是格高的整数倍（实测 348px ÷ 19.39px = 17.95），可见首行只露出半行，两侧 floor
 * 出来的行号天然差 1。
 *
 * 折算后落在终端视口之外的帧行返回 null：终端里根本没有这一行，宁可丢掉这次点击，
 * 也不能挪到别的行上去（那会变成「点取消却确认」这种事故）。非鼠标序列原样返回。
 */
export function translateMouseRow(
	data: string,
	frameLines: number,
	terminalRows: number,
): string | null {
	const m = SGR_MOUSE_RE.exec(data);
	if (!m) return data;
	if (
		!Number.isFinite(frameLines) ||
		!Number.isFinite(terminalRows) ||
		frameLines < 1 ||
		terminalRows < 1
	) {
		return data;
	}
	const [, button, col, rowText, final] = m;
	const viewportRow = Number.parseInt(rowText!, 10) - Math.max(0, frameLines - terminalRows);
	if (viewportRow < 1 || viewportRow > terminalRows) return null;
	return `\u001b[<${button};${col};${viewportRow}${final}`;
}
