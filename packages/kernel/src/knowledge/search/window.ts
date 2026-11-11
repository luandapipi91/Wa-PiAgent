// 自适应扩窗：命中块把同文件的相邻块合并成一段上下文（±N 块 / 总字符预算内），
// 让「命中一行」变成「看得懂的段落」；预算不足时不扩，宁可只给命中块本身。
export const WINDOW_NEIGHBOR_BLOCKS = 5;
export const WINDOW_MAX_CHARS = 6000;

export interface WindowRow {
  id: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  content: string;
  score: number;
}

export interface WindowChunk {
  id: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  content: string;
  score: number;
}

/**
 * 对同一文件的候选块做扩窗：按 startLine 排序，命中块（score > 0）与前后 neighborBlocks 个块合并，
 * 上下文邻块按约定 score = 0、只作内容不单独输出；
 * 合并后总字符超 maxChars 时退回命中块原文（不截断，避免给出半句）。
 * 只对同一文件内的连续块生效，跨文件不合并。
 */
export function expandWindow(
  rows: WindowRow[],
  neighborBlocks = WINDOW_NEIGHBOR_BLOCKS,
  maxChars = WINDOW_MAX_CHARS,
): WindowChunk[] {
  if (rows.length === 0) return [];
  // 按文件分组并按起始行排序（行号缺失的排在最后）
  const groups = new Map<string, WindowRow[]>();
  for (const row of rows) {
    const list = groups.get(row.filePath) ?? [];
    list.push(row);
    groups.set(row.filePath, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.startLine ?? Number.MAX_SAFE_INTEGER) - (b.startLine ?? Number.MAX_SAFE_INTEGER));
  }

  const out: WindowChunk[] = [];
  for (const [, list] of groups) {
    const covered = new Set<string>();
    for (const row of list) {
      // 输入约定：命中块 score > 0，纯上下文邻块 score = 0；只有命中块产生输出
      if (row.score <= 0) continue;
      if (covered.has(row.id)) continue;
      const idx = list.findIndex((r) => r.id === row.id);
      const from = Math.max(0, idx - neighborBlocks);
      const to = Math.min(list.length - 1, idx + neighborBlocks);
      const mergedRows = list.slice(from, to + 1);
      for (const r of mergedRows) covered.add(r.id);
      const merged = mergedRows.map((r) => r.content).join("\n…\n");
      // 预算不足：退回命中块原文（不扩窗）——行号必须跟着退回，否则 lines 与 content 对不上
      const inBudget = merged.length <= maxChars;
      out.push({
        id: row.id,
        filePath: row.filePath,
        startLine: inBudget ? mergedRows[0].startLine : row.startLine,
        endLine: inBudget ? mergedRows[mergedRows.length - 1].endLine : row.endLine,
        content: inBudget ? merged : row.content,
        score: row.score,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ============ adaptive 模式：同文件行窗扩展 ============
// 与块级扩窗的区别：块级只看「前后 N 个块」，行窗按源文件行号距离取上下文
// （±80 行），且最多带 5 个邻居、总长 6000 字符——对齐 pi-knowledge 的 adaptive 预算。

/** 行窗半径（行）：命中块前后各取多少行 */
export const LINE_WINDOW_RADIUS = 80;
/** 最多带多少个邻居块（不含命中块本身） */
export const LINE_WINDOW_MAX_NEIGHBORS = 5;
/** 行窗合并后的总字符预算 */
export const LINE_WINDOW_MAX_CHARS = 6000;

const startOf = (r: WindowRow): number => r.startLine ?? 0;
const endOf = (r: WindowRow): number => r.endLine ?? startOf(r);

/**
 * 行窗扩展：把同文件里与命中块相距 ≤ radius 行的邻居块拼成一段上下文。
 * - 邻居按「与命中块的距离」由近到远挑选，最多 maxNeighbors 个
 * - 拼接顺序按 startLine 升序（读起来是原文顺序）
 * - 命中块自身永远计入；总字符超 maxChars 时从最远的邻居开始丢弃
 * - 找不到命中块或预算不足只含命中块时，原样返回命中块内容
 */
export function expandLineWindow(
	rows: WindowRow[],
	hit: WindowRow,
	opts: { radius?: number; maxNeighbors?: number; maxChars?: number } = {},
): { content: string; startLine: number | null; endLine: number | null } {
	const radius = opts.radius ?? LINE_WINDOW_RADIUS;
	const maxNeighbors = opts.maxNeighbors ?? LINE_WINDOW_MAX_NEIGHBORS;
	const maxChars = opts.maxChars ?? LINE_WINDOW_MAX_CHARS;
	const asIs = { content: hit.content, startLine: hit.startLine, endLine: hit.endLine };
	const hitStart = startOf(hit);
	const hitEnd = endOf(hit);
	const sorted = [...rows].sort((a, b) => startOf(a) - startOf(b));
	const idx = sorted.findIndex((r) => r.id === hit.id);
	if (idx < 0) return asIs;

	// 由近到远挑邻居（左侧在第 idx 位之前，右侧之后）
	const candidates: Array<{ row: WindowRow; dist: number }> = [];
	for (let d = 1; d <= sorted.length; d++) {
		const prev = sorted[idx - d];
		const next = sorted[idx + d];
		if (!prev && !next) break;
		if (prev) {
			const dist = Math.max(0, hitStart - endOf(prev));
			if (dist <= radius) candidates.push({ row: prev, dist });
		}
		if (next) {
			const dist = Math.max(0, startOf(next) - hitEnd);
			if (dist <= radius) candidates.push({ row: next, dist });
		}
	}
	candidates.sort((a, b) => a.dist - b.dist);
	const picked = [hit];
	let chars = hit.content.length;
	for (const c of candidates) {
		if (picked.length - 1 >= maxNeighbors) break;
		if (chars + c.row.content.length + 1 > maxChars) continue;
		picked.push(c.row);
		chars += c.row.content.length + 1;
	}
	if (picked.length === 1) return asIs;
	picked.sort((a, b) => startOf(a) - startOf(b));
	const first = picked[0];
	const last = picked[picked.length - 1];
	return {
		content: picked.map((r) => r.content).join("\n"),
		startLine: first.startLine,
		endLine: last.endLine,
	};
}
