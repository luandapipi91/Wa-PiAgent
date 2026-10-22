import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

/** 一帧面板画面：整屏文本行（含 ANSI）+ 光标格坐标 */
export interface TuiFrame {
	lines: string[];
	cursor: { row: number; col: number } | null;
}

/**
 * 从渲染行里定位并剥离 CURSOR_MARKER，得到帧数据。
 *
 * pi-tui 的组件把 CURSOR_MARKER 插在光标位置，宿主负责把它转成真实光标定位；
 * 我们把它转成 (row, col) 交给前端画方块光标。列号按终端可见宽度计算
 * （CJK 占两格），因此复用 pi-tui 的 visibleWidth 而不是 string.length。
 * 只取第一个标记，其余一律剥离，避免标记文本泄漏到画面。
 */
export function extractFrame(lines: string[]): TuiFrame {
	const out: string[] = [];
	let cursor: { row: number; col: number } | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (cursor === null && line.includes(CURSOR_MARKER)) {
			const idx = line.indexOf(CURSOR_MARKER);
			const before = line.slice(0, idx);
			cursor = { row: i, col: visibleWidth(before) };
			out.push(before + stripAllMarkers(line.slice(idx + CURSOR_MARKER.length)));
		} else {
			out.push(stripAllMarkers(line));
		}
	}

	return { lines: out, cursor };
}

/** 剥离行内所有剩余的光标标记 */
function stripAllMarkers(line: string): string {
	if (!line.includes(CURSOR_MARKER)) return line;
	return line.split(CURSOR_MARKER).join("");
}

/** 两帧是否完全相同（内容 + 光标）；用于「内容相同不推送」 */
export function sameFrame(a: TuiFrame | null, b: TuiFrame): boolean {
	if (!a) return false;
	if ((a.cursor?.row ?? -1) !== (b.cursor?.row ?? -1)) return false;
	if ((a.cursor?.col ?? -1) !== (b.cursor?.col ?? -1)) return false;
	if (a.lines.length !== b.lines.length) return false;
	for (let i = 0; i < a.lines.length; i++) {
		if (a.lines[i] !== b.lines[i]) return false;
	}
	return true;
}
