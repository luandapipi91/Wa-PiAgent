// 移植自 pi-knowledge@0.13.0 dist/src/search/contracts.js（MIT）
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_WINDOW = 800;

/** 上游 chunk 形状 → Wa-Pi chunks 表的映射层（表结构不动，靠这个接口对齐） */
export interface RankChunk {
  id: string;
  kbId: string;
  filePath: string;
  fileType: string;
  content: string;
  contentHash: string;
  startLine: number | null;
  endLine: number | null;
  indexedAt: number;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Cancelled");
}
