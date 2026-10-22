// 记忆库结构迁移（schema_meta.schema_version 驱动，按版本号顺序执行、幂等）。
//
// v1 → v2：项目身份从「cwd 的 basename」改为「项目登记 id」。
// 旧的 memories.project_id 里存的是 basename（如 "Wa-Pi"），迁移时：
//   1. 每个不同的 basename 各建一条 legacy 登记项（id = 新 uuid，path 暂空，label = 原名）；
//   2. 把该 basename 下的记忆改挂到新 id；
//   3. path 留空 —— 该项目下次真正被打开时，解析器会把真实路径补上（见 projects.ts）。
//
// v2 → v3：为 memories 增加 embedding / embed_meta 两列（本地语义检索用），
//   并把 page_size 从 4096 提升到 16384（必须在 VACUUM 时才能生效，见 migrateToV3）。
// 迁移只跑一次：version 已是目标版本时直接返回。
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION } from "./schema";

/** 目标版本（注意：必须在 openMemoryDb 写 schema_version **之前** 调用本函数） */
export function migrateMemoryDb(db: Database): void {
  const row = db
    .query("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  // 无记录（全新库）视为 0：不会触发任何数据迁移，只落版本号
  const current = Number(row?.value ?? 0);

  if (current < 2) migrateProjectsToRegistry(db);
  if (current < 3) migrateToV3(db);

  db.run(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [SCHEMA_VERSION],
  );
}

/** v2：把 basename 形态的 project_id 换成登记 id（只处理非空值，global 条目的 NULL 不动） */
function migrateProjectsToRegistry(db: Database): void {
  const names = db
    .query(
      `SELECT DISTINCT project_id AS name FROM memories
       WHERE scope = 'project' AND project_id IS NOT NULL AND project_id <> ''`,
    )
    .all() as Array<{ name: string }>;
  if (names.length === 0) return;

  // 数据安全：迁移会改写 project_id（旧 basename → 登记 id），先整库备份一份，
  // 出问题时能直接换回。只备份一次；备份失败不阻断迁移（日志可见）。
  backupBeforeV2(db);

  const now = Date.now();
  const insertProject = db.prepare(
    "INSERT INTO memory_projects(id, path, label, created_at, last_seen_at) VALUES(?, NULL, ?, ?, ?)",
  );
  const rebind = db.prepare(
    "UPDATE memories SET project_id = ? WHERE project_id = ?",
  );

  // 默认工作区（无绑定项目）的历史会话，其 project_id 是 cwd 里的会话时间戳（纯数字）。
  // 新规则下所有默认工作区会话共用一个身份（解析时归一到 <WA_PI_DIR>/workdir），
  // 故迁移时把它们全部并到一条 label="workdir" 的登记项，避免历史记忆成 18 个孤岛。
  const bootNames = names.filter(({ name }) => /^\d+$/.test(name));
  if (bootNames.length > 0) {
    const bootId = randomUUID();
    insertProject.run(bootId, "workdir", now, now);
    for (const { name } of bootNames) rebind.run(bootId, name);
  }

  for (const { name } of names) {
    if (/^\d+$/.test(name)) continue; // 已在上面并入默认工作区身份
    const id = randomUUID();
    insertProject.run(id, name, now, now);
    rebind.run(id, name);
  }
  insertProject.finalize();
  rebind.finalize();
}

/** v2 迁移前的整库备份：<db>.pre-v2.bak（先 checkpoint，保证备份自包含 WAL 数据） */
function backupBeforeV2(db: Database): void {
  const file = db.filename;
  if (!file || file.startsWith(":memory:") || file.startsWith("file::memory:"))
    return;
  const backup = `${file}.pre-v2.bak`;
  if (existsSync(backup)) return;
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(file, backup);
  } catch (err) {
    console.error("[memory-migrate] v2 迁移前备份失败（继续迁移）:", err);
  }
}

/** v3：为 memories 增加 embedding / embed_meta 两列，并把 page_size 提升到 16K */
function migrateToV3(db: Database): void {
  const existing = (db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!existing.includes("embedding")) db.run("ALTER TABLE memories ADD COLUMN embedding BLOB");
  if (!existing.includes("embed_meta")) db.run("ALTER TABLE memories ADD COLUMN embed_meta TEXT");

  // page_size 只能在 VACUUM 时生效。512 维 float32 = 2048B/行恰好是 4096 页的一半，
  // 每页只放 1 行 → 膨胀 101%（实测 195MB → 391MB）；16K 页把膨胀压到 ~14%。
  // 内存库（:memory:）不做重建，测试与临时库不需要。
  const file = db.filename;
  if (!file || file.startsWith(":memory:") || file.startsWith("file::memory:")) return;
  const { page_size: pageSize } = db.query("PRAGMA page_size").get() as { page_size: number };
  if (pageSize >= 16384) return;

  // VACUUM 会重建整库，先做一次自包含备份（同 v2 的做法）。
  try {
    const backup = `${file}.pre-v3.bak`;
    if (!existsSync(backup)) {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(file, backup);
    }
  } catch (err) {
    console.error("[memory-migrate] v3 迁移前备份失败（继续迁移）:", err);
  }

  // page_size 只在 VACUUM 时生效，而 WAL 下 VACUUM 不会改变页大小，
  // 必须先临时切出 WAL（生产库在 openMemoryDb 里已被设成 WAL），VACUUM 后再切回。
  // 任何一步失败都只降级记日志：记忆库必须仍能打开，只是页大小保持原值。
  const wasWal = journalMode(db) === "wal";
  try {
    const mode = (
      db.query("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }
    ).journal_mode;
    if (mode === "wal") throw new Error(`journal_mode 未能切出 WAL（仍为 ${mode}）`);
    db.run("PRAGMA page_size = 16384");
    db.run("VACUUM");
  } catch (err) {
    console.error("[memory-migrate] v3 page_size 提升失败（页大小保持原值，记忆库仍可用）:", err);
  } finally {
    // 切回 WAL 必须执行，否则生产库会退回 DELETE 日志模式
    if (wasWal) {
      try {
        db.run("PRAGMA journal_mode = WAL");
      } catch (err) {
        console.error("[memory-migrate] v3 迁移后切回 WAL 失败:", err);
      }
    }
  }
}

/** 当前日志模式；查询失败时返回空串（交由调用方按「非 WAL」处理） */
function journalMode(db: Database): string {
  try {
    return (db.query("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
  } catch {
    return "";
  }
}
