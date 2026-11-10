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
      // 预算不足：退回命中块原文（不扩窗）
      const content = merged.length <= maxChars ? merged : row.content;
      out.push({
        id: row.id,
        filePath: row.filePath,
        startLine: mergedRows[0].startLine,
        endLine: mergedRows[mergedRows.length - 1].endLine,
        content,
        score: row.score,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
