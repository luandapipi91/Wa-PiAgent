// 一次性迁移：把历史 markdown 记忆与归档 sidecar 导入 SQLite。
//
// 时间戳还原（关键）：新条目按惯例加在文件顶部，因此把文件内顺序映射为
// created_at = mtime - index 秒，使“顶部更新”的语义在库里成立，
// L1 预算截断时自然优先保留顶部（较新）条目。
import { readFile, readdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDao, MemoryKind } from "./dao";

const DELIMITER = "\n§\n";
const IMPORTED_SUFFIX = ".imported";

type LegacyTarget = "memory" | "user";

function kindFor(target: LegacyTarget, scope: "global" | "project"): MemoryKind {
  return target === "user" && scope === "global" ? "profile" : "knowledge";
}

/** 导入单个 markdown 文件；返回导入条数；文件不存在返回 0 */
async function importFile(
  dao: MemoryDao,
  absPath: string,
  scope: "global" | "project",
  projectId: string | null,
  target: LegacyTarget,
): Promise<number> {
  if (!existsSync(absPath)) return 0;
  const raw = await readFile(absPath, "utf8");
  const info = await stat(absPath);
  const entries = raw
    .split(DELIMITER)
    .map((e) => e.trim())
    .filter(Boolean);

  entries.forEach((content, index) => {
    const row = dao.insert({
      kind: kindFor(target, scope),
      target,
      scope,
      projectId,
      content,
      source: "import",
    });
    // 顺序 → 时间戳：第 index 条比第 0 条早 index 秒
    const createdAt = Math.round(info.mtimeMs) - index * 1000;
    dao.db.run("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?", [
      createdAt,
      createdAt,
      row.id,
    ]);
  });

  await rename(absPath, absPath + IMPORTED_SUFFIX);
  return entries.length;
}

async function importProjectsMemory(dao: MemoryDao, waPiDir: string): Promise<void> {
  const base = join(waPiDir, "projects-memory");
  if (!existsSync(base)) return;
  for (const name of await readdir(base)) {
    const dir = join(base, name);
    await importFile(dao, join(dir, "MEMORY.md"), "project", name, "memory");
    await importFile(dao, join(dir, "USER.md"), "project", name, "user");
  }
}

async function importArchive(dao: MemoryDao, waPiDir: string): Promise<void> {
  const p = join(waPiDir, "memory-archive.json");
  if (!existsSync(p)) return;
  try {
    const data = JSON.parse(await readFile(p, "utf8")) as {
      entries?: Array<{ text: string; category?: string; scope?: string; archivedAt?: string }>;
    };
    for (const e of data.entries ?? []) {
      if (!e.text?.trim()) continue;
      const row = dao.insert({
        kind: "knowledge",
        target: e.category === "user" ? "user" : "memory",
        scope: e.scope === "project" ? "project" : "global",
        projectId: null,
        content: e.text,
        source: "import",
      });
      dao.archive(row.id);
      // 迁移保真：dao.archive() 只能写“现在”，会把 sidecar 里的真实归档时间冲掉，
      // 故在此回填原始时间；已归档的该条目不会再有其他写入者，回填安全。
      // sidecar 里的 archivedAt 缺失或无法解析时保持 dao.archive() 写的值（不抛错）。
      const archivedAt =
        typeof e.archivedAt === "string" ? Date.parse(e.archivedAt) : Number.NaN;
      if (Number.isFinite(archivedAt)) {
        dao.db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [archivedAt, row.id]);
      }
    }
    await rename(p, p + IMPORTED_SUFFIX);
  } catch {
    // 归档文件损坏 → 跳过，不阻断启动
  }
}

/**
 * 执行迁移。幂等：文件已重命名为 .imported 后不再重复导入。
 * 任一环节失败都不应阻断 kernel 启动。
 */
export async function importLegacyMemories(waPiDir: string, dao: MemoryDao): Promise<void> {
  const globalDir = join(waPiDir, "memories", "global");
  await importFile(dao, join(globalDir, "MEMORY.md"), "global", null, "memory");
  await importFile(dao, join(globalDir, "USER.md"), "global", null, "user");
  await importProjectsMemory(dao, waPiDir);
  await importArchive(dao, waPiDir);
}
