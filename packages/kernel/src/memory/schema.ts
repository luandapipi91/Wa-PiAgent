// 记忆库表结构（规格 §4 逐字落地）。
// 单库统管 global + project：用 scope / project_id 区分，取代原先的多目录树。
export const SCHEMA_VERSION = "1";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target       TEXT NOT NULL,
  scope        TEXT NOT NULL,
  project_id   TEXT,
  content      TEXT NOT NULL,
  title        TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  archived_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_layer  ON memories(archived, scope, project_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_recent ON memories(archived, updated_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  body,
  memory_id UNINDEXED,
  tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
