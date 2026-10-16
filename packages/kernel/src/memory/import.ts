// 一次性迁移：把历史 markdown 记忆与归档 sidecar 导入 SQLite。
//
// 时间戳还原（关键）：新条目按惯例加在文件顶部，因此把文件内顺序映射为
// created_at = mtime - index 秒，使“顶部更新”的语义在库里成立，
// L1 预算截断时自然优先保留顶部（较新）条目。
//
// 容错（关键）：kernel 启动时会调用本模块（任务 12 接线）。迁移必须“尽量导”：
// 每个来源各自独立 try/catch，一处失败只跳过该来源并打印日志，绝不向上抛——
// 一份不可读的 MEMORY.md、一次 readdir 或一次 rename 失败都不该让 kernel 启动不了。
// 不能用外层一刀切：那样一份坏文件会让整个迁移中止，其余来源白丢。
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDao, MemoryKind } from "./dao";
import { ensureProjectByLabel } from "./projects";

const DELIMITER = "\n§\n";
const IMPORTED_SUFFIX = ".imported";

type LegacyTarget = "memory" | "user";
type LegacyScope = "global" | "project";

function kindFor(target: LegacyTarget, scope: LegacyScope): MemoryKind {
  return target === "user" && scope === "global" ? "profile" : "knowledge";
}

/** 归档 sidecar 的单条记录（只声明迁移用得到的字段） */
interface SidecarEntry {
  id?: string;
  text: string;
  category?: string;
  scope?: string;
  archivedAt?: string;
  /** 旧 MemoryStore 写入的条目来源文件绝对路径 */
  sourceFile?: string;
}

/**
 * 从 sidecar 条目解析项目名：优先 sourceFile（绝对路径），回退 id（"<relPath>:<rawIndex>"）。
 * 两者都形如 .../projects-memory/<name>/MEMORY.md —— 项目名一直都在，故不该丢：
 * 丢了就会得到 scope=project 且 project_id=NULL 的孤儿行（任何按项目切分的视图都看不到它，
 * 但跨域 search 仍能命中），用户点「恢复」后条目等于凭空消失。
 * 分隔符可能是 \\ 或 /，归一化后再匹配。
 */
function projectIdFromSidecar(e: SidecarEntry): string | null {
  const raw =
    typeof e.sourceFile === "string" && e.sourceFile ? e.sourceFile : e.id;
  if (typeof raw !== "string" || !raw) return null;
  const m = /(?:^|\/)projects-memory\/([^/]+)\//.exec(raw.replace(/\\/g, "/"));
  return m ? m[1]! : null;
}

/**
 * 逐来源容错：只跑一个来源，失败则打印该来源路径与错误后跳过。
 * 日志必须保留（console.error）——静默吞掉会让迁移悄悄少导而无人知晓。
 */
async function importSafely(
  label: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`[memory-import] 导入失败，已跳过该来源：${label}`, err);
  }
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

  // 插入与重命名放进同一事务（故 :renameSync 而非 await rename）——
  // rename 失败（权限、目标是非空目录）时插入一并回滚，避免「已插入 + 未改名」
  // 导致下次启动重复导入并累积。bun:sqlite 的事务在第一个 await 之后就不再受回滚
  // 保护，事务体内只能用同步 fs。
  dao.db.transaction(() => {
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
      dao.db.run(
        "UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?",
        [createdAt, createdAt, row.id],
      );
    });
    renameSync(absPath, absPath + IMPORTED_SUFFIX);
  })();

  return entries.length;
}

async function importProjectsMemory(
  dao: MemoryDao,
  waPiDir: string,
): Promise<void> {
  const base = join(waPiDir, "projects-memory");
  if (!existsSync(base)) return;
  for (const name of await readdir(base)) {
    const dir = join(base, name);
    // 同一项目下的两个文件、以及各项目之间都独立容错：一个坏文件不妨碍其余导入
    const memoryPath = join(dir, "MEMORY.md");
    const userPath = join(dir, "USER.md");
    // 项目目录名 → 登记 id（迁移 v2 后 memories.project_id 存的是登记 id；直接用目录名会成孤儿）
    await importSafely(memoryPath, () =>
      importFile(dao, memoryPath, "project", ensureProjectByLabel(dao.db, name), "memory"),
    );
    await importSafely(userPath, () =>
      importFile(dao, userPath, "project", ensureProjectByLabel(dao.db, name), "user"),
    );
  }
}

async function importArchive(dao: MemoryDao, waPiDir: string): Promise<void> {
  const p = join(waPiDir, "memory-archive.json");
  if (!existsSync(p)) return;
  try {
    const data = JSON.parse(await readFile(p, "utf8")) as {
      entries?: SidecarEntry[];
    };
    // 整批一个事务：任一条插入或最后的重命名失败即全部回滚，文件保持原名，
    // 下次启动整体重试，不留下「导了一半」的中间态。
    dao.db.transaction(() => {
      for (const e of data.entries ?? []) {
        if (!e.text?.trim()) continue;
        const target: LegacyTarget = e.category === "user" ? "user" : "memory";
        const scope: LegacyScope = e.scope === "project" ? "project" : "global";
        // 旧 sidecar 存的是项目名（目录名）→ 换成登记 id
        const legacyName = scope === "project" ? projectIdFromSidecar(e) : null;
        const projectId = legacyName
          ? ensureProjectByLabel(dao.db, legacyName)
          : null;
        if (scope === "project" && !projectId) {
          // 不能静默产出 project_id 为空的项目条目：它不属于任何项目，
          // 恢复后会从所有按项目切分的视图里消失，故必须留日志。
          console.error(
            `[memory-import] 归档条目无法解析项目名，project_id 留空：${e.id ?? e.sourceFile ?? "(无 id)"}`,
          );
        }
        const row = dao.insert({
          // kind 与 markdown 分支同一套规则（kindFor）：user+global → profile，其余 knowledge
          kind: kindFor(target, scope),
          target,
          scope,
          projectId,
          content: e.text,
          source: "import",
        });
        dao.archive(row.id);
        // 迁移保真：dao.archive() 只能写“现在”，会把 sidecar 里的真实归档时间冲掉，
        // 故在此回填原始时间；已归档的该条目不会再有其他写入者，回填安全。
        // sidecar 里的 archivedAt 缺失或无法解析时保持 dao.archive() 写的值（不抛错）。
        const archivedAt =
          typeof e.archivedAt === "string"
            ? Date.parse(e.archivedAt)
            : Number.NaN;
        if (Number.isFinite(archivedAt)) {
          dao.db.run("UPDATE memories SET archived_at = ? WHERE id = ?", [
            archivedAt,
            row.id,
          ]);
        }
      }
      renameSync(p, p + IMPORTED_SUFFIX);
    })();
  } catch (err) {
    // 归档文件损坏 / 重命名失败 → 整批回滚并跳过，不阻断启动；留日志便于排查
    console.error(`[memory-import] 归档导入失败，已跳过：${p}`, err);
  }
}

/**
 * 执行迁移。幂等：文件已重命名为 .imported 后不再重复导入。
 * 任一来源失败都不应阻断 kernel 启动：逐来源独立 try/catch，失败留日志。
 */
export async function importLegacyMemories(
  waPiDir: string,
  dao: MemoryDao,
): Promise<void> {
  const globalDir = join(waPiDir, "memories", "global");
  const globalMemory = join(globalDir, "MEMORY.md");
  const globalUser = join(globalDir, "USER.md");

  await importSafely(globalMemory, () =>
    importFile(dao, globalMemory, "global", null, "memory"),
  );
  await importSafely(globalUser, () =>
    importFile(dao, globalUser, "global", null, "user"),
  );
  // 项目域整体包一层（内含 readdir），其每个文件在 importProjectsMemory 内部已各自容错
  await importSafely(join(waPiDir, "projects-memory"), () =>
    importProjectsMemory(dao, waPiDir),
  );
  // importArchive 自带 try/catch：损坏 JSON 仍静默跳过（既有行为，不改）
  await importArchive(dao, waPiDir);
}
