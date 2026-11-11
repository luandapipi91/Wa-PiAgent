// 知识库模块桶导出。后续任务（indexer/watcher/search/tool）追加导出时都走这里。
import type { KbProgressEvent } from "@wa-pi/shared";
import type { KnowledgeStore } from "./store";

/** 知识库各入口共享的运行上下文（indexer/watcher/search/routes 复用，见任务 7/11） */
export interface KbContext {
  /** 登记库读写入口（knowledge.db） */
  store: KnowledgeStore;
  /** WA_PI_DIR：每库独立 db 的定位根 */
  waPiDir: string;
  /** 进度 SSE 广播回调（ws-server 接线在任务 9；测试注入收集器） */
  sse: (evt: KbProgressEvent) => void;
}

export { SCHEMA_VERSION, KB_SCHEMA_SQL, KB_DB_SCHEMA_SQL } from "./schema";
export { knowledgeDbPath, knowledgeDir, kbDbPath } from "./paths";
export { KnowledgeStore, JOB_STUCK_MS, type KbJob } from "./store";
export { openKbDb, openKbDbExisting, evictKbDb, closeAllKbDbs, KbDbMissingError } from "./kb-db";
export {
  scanFolder,
  SUGGESTED_EXCLUDES,
  MAX_FILE_BYTES,
  type ScanPreview,
  type ScannedFile,
  type ScanSkip,
  type KbFileType,
  type KbSkipReason,
} from "./scan";
export { extractText, ExtractionError, type ExtractedText } from "./extract";
export { chunkDocument, estimateTokens, type KnowledgeChunk, type ChunkerDoc } from "./chunker";
export {
  initKbVectorColumn,
  isKbVectorReady,
  refreshKbQuantizedIndex,
  kbQuantizedScan,
  KB_SCAN_K,
} from "./vector";
export {
  searchKnowledge,
  type QueryEmbedFn,
  type RerankFn,
  type SearchOptions,
  type StatFn,
} from "./search";
export type { KbSearchHit, KbSearchResult, KbSkippedKb } from "@wa-pi/shared";
export { weightedScoreFusion } from "./search/fusion";
export { MIN_HYBRID_SCORE, hasEnoughLexicalEvidence, scoreChunkForQuery } from "./search/ranking";
export {
  diversifyRankedChunks,
  interleaveByFile,
  type DiversityMode,
  type RankedCandidate,
} from "./search/diversity";
export { diagnoseKb, type KbDiagnostic } from "./diagnostics";
export { runDoctor, scoreFromIssues, type DoctorReport, type DoctorIssue } from "./doctor";
export { KB_CHUNKER_VERSION, knowledgeFingerprint } from "./fingerprint";
export {
  watchKb,
  restoreWatchers,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_DEBOUNCE_MS,
  type WatchKbOptions,
  type IndexFn,
  type KbWatchController,
  type RestoreWatchersController,
} from "./watcher";
export { makeKnowledgeToolContext, type KnowledgeToolContext } from "./tool";
