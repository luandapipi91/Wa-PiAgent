// 移植自 pi-knowledge@0.13.0 dist/src/search/contracts.js（MIT）
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_WINDOW = 800;

/** 上游 chunk 形状 → Wa-Pi chunks 表的映射层（表结构不动，靠这个接口对齐） */
export interface RankChunk {
  id: string;
  kbId: string;
  filePath: string;
  /** 已归一的上游词汇（md→markdown、txt→text，见 ranking.normalizeKbFileType） */
  fileType: string;
  content: string;
  contentHash: string;
  startLine: number | null;
  endLine: number | null;
  indexedAt: number;
  /** 标题与面包屑：参与覆盖率/词法证据判定（上游 buildChunkEmbeddingText 的一部分） */
  title?: string | null;
  breadcrumb?: string | null;
  /** 上游 chunk.metadata_json 在 Wa-Pi chunks 表暂无对应列：恒 undefined，
   *  adaptive 的 relationBoost 因此恒为 0（不新增 schema 列） */
  metadataJson?: string | null;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Cancelled");
}
