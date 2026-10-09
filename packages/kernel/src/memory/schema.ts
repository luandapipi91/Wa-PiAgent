// 记忆库表结构（规格 §4 逐字落地）。
// 单库统管 global + project：用 scope / project_id 区分，取代原先的多目录树。
// v2：project_id 存「项目登记 id」（memory_projects.id），不再直接存 cwd basename ——
// 登记 id 稳定且唯一，同一个项目可挂多条路径（改名/移动后新路径并入原项目）。
// v3：新增 embedding / embed_meta 两列，供本地语义检索使用（见 specs/2026-09-30-memory-semantic-search.md）。
//     embed_meta 存模型指纹（model:dtype:dim），指纹不匹配即视为「未索引」，由后台任务回填。
export const SCHEMA_VERSION = "3";

/**
 * 嵌入向量维度。
 * 单一来源：embedder 与 vector-ext 都从这里导入，避免两处硬编码各自漂移
 * （两个模块保持互不依赖，只共同依赖本文件）。
 */
export const EMBED_DIM = 512;

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
  archived_at  INTEGER,
  embedding    BLOB,
  embed_meta   TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_layer  ON memories(archived, scope, project_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_recent ON memories(archived, updated_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  body,
  memory_id UNINDEXED,
  tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_projects (
  id           TEXT NOT NULL,
  path         TEXT,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (id, path)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_project_path ON memory_projects(path);
CREATE INDEX IF NOT EXISTS idx_mem_project_label ON memory_projects(label);
`;
