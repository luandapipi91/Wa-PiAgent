// 知识库表结构（规格 §6.1 逐字落地，两层：总登记库 + 每库独立库）。
// 总登记库 <WA_PI_DIR>/knowledge.db：knowledge_bases + indexing_jobs；
// 每库独立库 <WA_PI_DIR>/knowledge/<kbId>.db：chunks + chunks_fts（chunks 主键
// 用 TEXT uuid 而非规格的 INTEGER rowid——quantizedScan 返回的 VectorHit.id 是
// string，TEXT 主键让块 id 跨层稳定可引用）。
// v1：初始版本。
export const SCHEMA_VERSION = "1";

/** 总登记库（规格 §6.1 两张表 + auto_watch 列） */
export const KB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,            -- uuid
  name TEXT NOT NULL,             -- 用户命名；不填时默认取文件夹 basename
  description TEXT NOT NULL DEFAULT '', -- 作用描述：告诉智能体这个库存什么、什么时候该查（注入 system prompt）；不填时用「来自文件夹「<名>」的资料索引…」默认模板（见 §6.8）
  folder_path TEXT NOT NULL,      -- 入口文件夹（绝对路径）
  status TEXT NOT NULL,           -- scanning | indexing | ready | error
  file_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0, -- 解析/嵌入失败文件数（界面可见）
  embed_meta TEXT,                -- 模型指纹 model:dtype:dim
  auto_watch INTEGER NOT NULL DEFAULT 1, -- 目录变更自动重建索引（用户可关）
  last_indexed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS indexing_jobs (
  kb_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,            -- scanning | extracting | chunking | embedding | committing
  files_total INTEGER, files_done INTEGER,
  chunks_done INTEGER,
  skip_stats TEXT,                -- JSON：跳过原因 → 数量
  last_progress_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** 每库独立库（规格 §6.1 chunks + chunks_fts；kb_id 不需要——物理隔离） */
export const KB_DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,            -- uuid（quantizedScan 的 VectorHit.id 是 string）
  file_path TEXT NOT NULL,        -- 相对 kb 根的路径
  file_type TEXT NOT NULL,        -- md | txt | docx | pdf | html
  title TEXT,                     -- 所在标题（面包屑末级）
  breadcrumb TEXT,                -- 完整标题链「产品 > 定价 > 折扣」
  start_line INTEGER, end_line INTEGER,
  content TEXT NOT NULL,          -- 原始正文（展示给智能体的）
  prefix_content TEXT NOT NULL,   -- 身份前缀 + 正文（嵌入输入源，见 §6.4）
  content_hash TEXT NOT NULL,     -- sha256(相对路径+行号+内容+metadata)
  file_mtime INTEGER NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0, -- 字节数（§6.3 增量快筛要求 mtime+size 双比对；§6.1 表结构未含此列，为满足快筛语义补——v1 未发布无迁移负担）
  embedding BLOB,                 -- 量化向量（embed_meta 不匹配视为未索引，后台回填）
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(body, chunk_id UNINDEXED, tokenize='unicode61');
`;
