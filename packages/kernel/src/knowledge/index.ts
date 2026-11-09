// 知识库模块桶导出。后续任务（indexer/watcher/search/tool）追加导出时都走这里。
export { SCHEMA_VERSION, KB_SCHEMA_SQL, KB_DB_SCHEMA_SQL } from "./schema";
export { knowledgeDbPath, knowledgeDir, kbDbPath } from "./paths";
export { KnowledgeStore, JOB_STUCK_MS, type KbJob } from "./store";
export { openKbDb } from "./kb-db";
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
export {
  initKbVectorColumn,
  isKbVectorReady,
  refreshKbQuantizedIndex,
  kbQuantizedScan,
  KB_SCAN_K,
} from "./vector";
