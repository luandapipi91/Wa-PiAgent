// 记忆的项目身份（project key）契约：
//
// 现状（v1）：memories.project_id 存的是 cwd 的 basename —— 不同路径的同名文件夹会串，
// 文件夹改名/移动后旧记忆成孤儿，默认工作区会话（cwd = workdir/<会话时间戳>）每次
// 会话各成一个"项目"。
//
// 本批改为登记制（v2）：
// - 新表 memory_projects：id（稳定 uuid，一个项目一个） + path（归一化完整路径，全局唯一）
//   + label（末段名）；同一个 id 可挂多条 path —— 改名/移动后新路径并入原项目。
// - memories.project_id 改存登记 id。
// - 解析规则（resolveProjectKey）：路径命中登记 → 直接用；未命中 → 按末段名找候选，
//   唯一候选且它记录的旧路径都不存在（= 被移动）→ 新路径并入该 id 接回；否则新建。
// - 默认工作区：cwd 为 <defaultWorkspaceDir>/<纯数字时间戳> 时归一到 defaultWorkspaceDir，
//   所有默认工作区会话共用同一个身份。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/memory/schema";
import { migrateMemoryDb } from "../src/memory/migrations";
import { ensureProjectByLabel, resolveProjectKey } from "../src/memory/projects";

let root: string;
let db: Database;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-projects-"));
  dbPath = join(root, "memories.db");
  db = new Database(dbPath, { create: true });
  db.run(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 造一条 v1 形态的项目记忆（project_id 直接是 basename） */
function insertLegacy(content: string, projectName: string) {
  db.run(
    `INSERT INTO memories (id, kind, target, scope, project_id, content, title, tags, source, created_at, updated_at, last_used_at, use_count, archived, archived_at)
     VALUES (?, 'knowledge', 'memory', 'project', ?, ?, ?, '', 'agent', 1, 1, NULL, 0, 0, NULL)`,
    [crypto.randomUUID(), projectName, content, content],
  );
}

const projectIds = (): string[] =>
  (
    db.query("SELECT DISTINCT project_id AS p FROM memories ORDER BY p").all() as Array<{
      p: string | null;
    }>
  ).map((r) => r.p ?? "(null)");

const projectRows = () =>
  db
    .query("SELECT id, path, label FROM memory_projects ORDER BY label, path")
    .all() as Array<{ id: string; path: string | null; label: string }>;

// ── 迁移 ────────────────────────────────────────────────────────────────

test("迁移 v1 → v2：旧 basename 标签各建一条 legacy 登记项，记忆指向新 id 且仍可按文件夹名访问", () => {
  insertLegacy("Wa-Pi 的旧记忆", "Wa-Pi");
  insertLegacy("hlk 的旧记忆", "hlk");
  db.run(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  migrateMemoryDb(db);

  // 记忆不再直接存 basename
  expect(projectIds()).toHaveLength(2);
  expect(projectIds()).not.toContain("Wa-Pi");
  // legacy 登记项：label 保留原名、path 暂空
  const rows = projectRows();
  expect(rows.map((r) => r.label).sort()).toEqual(["Wa-Pi", "hlk"]);
  expect(rows.every((r) => r.path === null)).toBe(true);
  // 版本推进
  const ver = db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
    value: string;
  };
  expect(ver.value).toBe(SCHEMA_VERSION);

  // 旧记忆仍能按文件夹名解析到（首次解析把 legacy 项补上真实路径）
  const waPiDir = join(root, "work", "Wa-Pi");
  mkdirSync(waPiDir, { recursive: true });
  const key = resolveProjectKey(db, waPiDir);
  expect(key).not.toBeNull();
  const waPiRow = projectRows().find((r) => r.label === "Wa-Pi")!;
  expect(key).toBe(waPiRow.id);
  expect(
    db.query("SELECT COUNT(*) AS n FROM memories WHERE project_id = ?").get(key) as {
      n: number;
    },
  ).toEqual({ n: 1 });
  // legacy 项被补上真实路径（原本 path 为空）
  const after = db
    .query("SELECT path FROM memory_projects WHERE id = ?")
    .all(key!) as Array<{ path: string | null }>;
  expect(after.map((r) => r.path).filter(Boolean)).toHaveLength(1);
});

test("迁移幂等：已是 v2 的库再跑一次不重建登记项、不改动记忆", () => {
  insertLegacy("Wa-Pi 的旧记忆", "Wa-Pi");
  db.run(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  migrateMemoryDb(db);
  const before = projectRows();
  const ids = projectIds();

  migrateMemoryDb(db);

  expect(projectRows()).toEqual(before);
  expect(projectIds()).toEqual(ids);
});

test("迁移 v1 → v2 前先备份原库（.pre-v2.bak）；重复迁移不覆盖备份", () => {
  insertLegacy("旧记忆", "Wa-Pi");
  db.run(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const backup = `${dbPath}.pre-v2.bak`;
  expect(existsSync(backup)).toBe(false);

  migrateMemoryDb(db);

  expect(existsSync(backup)).toBe(true);
  const readBackupProjectId = () => {
    const b = new Database(backup, { readonly: true });
    const row = b.query("SELECT project_id AS p FROM memories").get() as {
      p: string;
    };
    b.close();
    return row.p;
  };
  // 备份里保留的是迁移前的旧格式（project_id = basename）
  expect(readBackupProjectId()).toBe("Wa-Pi");

  migrateMemoryDb(db);
  expect(readBackupProjectId()).toBe("Wa-Pi");
});

test("迁移：纯数字标签（默认工作区会话时间戳）全部并到一个 workdir 登记项", () => {
  insertLegacy("默认工作区旧记忆 A", "1789954865560");
  insertLegacy("默认工作区旧记忆 B", "1789954865561");
  insertLegacy("真实项目记忆", "Wa-Pi");
  db.run(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  migrateMemoryDb(db);

  const rows = projectRows();
  const bootRows = rows.filter((r) => r.label === "workdir");
  expect(bootRows).toHaveLength(1);
  const bootIds = (
    db
      .query(
        "SELECT DISTINCT project_id AS p FROM memories WHERE content LIKE '默认工作区旧记忆%'",
      )
      .all() as Array<{ p: string }>
  ).map((r) => r.p);
  expect(bootIds).toEqual([bootRows[0].id]);
  // 默认工作区身份可以解析到（path 为空 → 首次解析补上 workdir 真实路径）
  const workdir = join(root, "workdir");
  mkdirSync(workdir, { recursive: true });
  expect(resolveProjectKey(db, workdir, { defaultWorkspaceDir: workdir })).toBe(
    bootRows[0].id,
  );
});

test("全新库（无记忆）迁移后不产生任何登记项", () => {
  migrateMemoryDb(db);
  expect(projectRows()).toHaveLength(0);
});

// ── 解析：命中 / 新建 ────────────────────────────────────────────────────

test("同一路径重复解析命中同一个 id，第二个项目路径得到不同 id", () => {
  const a = join(root, "work", "app-a");
  const b = join(root, "work", "app-b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });

  const idA1 = resolveProjectKey(db, a);
  const idA2 = resolveProjectKey(db, a);
  const idB = resolveProjectKey(db, b);

  expect(idA1).toBe(idA2);
  expect(idA1).not.toBe(idB);
  expect(projectRows()).toHaveLength(2);
});

test("同名的两个不同路径：前者仍在磁盘上时不误接，各自独立", () => {
  // macOS 的 /private/tmp 与 /tmp 是同目录（符号链接），这里用不同父目录避开
  const first = join(root, "one", "api");
  const second = join(root, "two", "api");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  const id1 = resolveProjectKey(db, first);
  const id2 = resolveProjectKey(db, second);

  expect(id1).not.toBe(id2);
  expect(projectRows().filter((r) => r.label === "api")).toHaveLength(2);
});

// ── 解析：移动 / 改名 / 多候选 ───────────────────────────────────────────

test("移动文件夹（末段名不变、旧路径已不存在）→ 新路径并入原项目，记忆接回", () => {
  const oldDir = join(root, "work", "Wa-Pi");
  const newDir = join(root, "archive", "Wa-Pi");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });

  const idBefore = resolveProjectKey(db, oldDir);
  insertLegacy("迁移前的记忆", "Wa-Pi");
  // legacy 记忆属于"Wa-Pi"这个名字，先并入上面解析出的项目
  db.run("UPDATE memories SET project_id = ? WHERE project_id = 'Wa-Pi'", [idBefore!]);

  renameSync(oldDir, newDir); // 移动（旧路径消失）
  const idAfter = resolveProjectKey(db, newDir);

  expect(idAfter).toBe(idBefore);
  const paths = (
    db.query("SELECT path FROM memory_projects WHERE id = ?").all(idAfter!) as Array<{
      path: string;
    }>
  ).map((r) => r.path);
  const lower = paths.map((p) => p.toLowerCase());
  expect(lower).toContain(oldDir.toLowerCase());
  expect(lower).toContain(newDir.toLowerCase());
  // 记忆仍挂在同一项目下
  expect(
    (db.query("SELECT COUNT(*) AS n FROM memories WHERE project_id = ?").get(idAfter!) as {
      n: number;
    }).n,
  ).toBe(1);
});

test("连文件夹名一起改 → 没有可靠线索，按新项目处理（不误接）", () => {
  const oldDir = join(root, "work", "old-name");
  const newDir = join(root, "work", "new-name");
  mkdirSync(oldDir, { recursive: true });

  const idBefore = resolveProjectKey(db, oldDir);
  renameSync(oldDir, newDir);
  const idAfter = resolveProjectKey(db, newDir);

  expect(idAfter).not.toBe(idBefore);
});

test("同名候选有多个 → 不猜，按新项目处理", () => {
  const a = join(root, "a", "api");
  const b = join(root, "b", "api");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  resolveProjectKey(db, a);
  resolveProjectKey(db, b);

  // 两个 api 都仍在磁盘上 → 第三个同名路径既不命中、候选也不唯一
  const c = join(root, "c", "api");
  mkdirSync(c, { recursive: true });
  const idC = resolveProjectKey(db, c);
  expect(projectRows().filter((r) => r.label === "api")).toHaveLength(3);
  expect(new Set(projectRows().map((r) => r.id)).size).toBe(3);
  expect(idC).toBeTruthy();
});

// ── 解析：默认工作区共用身份 ─────────────────────────────────────────────

test("默认工作区：workdir/<时间戳> 归一到 workdir，所有会话共用一个身份", () => {
  const workdir = join(root, "workdir");
  mkdirSync(join(workdir, "1789954865560"), { recursive: true });
  mkdirSync(join(workdir, "1789954865561"), { recursive: true });

  const k1 = resolveProjectKey(db, join(workdir, "1789954865560"), {
    defaultWorkspaceDir: workdir,
  });
  const k2 = resolveProjectKey(db, join(workdir, "1789954865561"), {
    defaultWorkspaceDir: workdir,
  });

  expect(k1).toBe(k2);
  expect(projectRows()).toHaveLength(1);
  // path 列按平台归一（darwin 下小写），断言不区分大小写
  expect((projectRows()[0].path ?? "").toLowerCase()).toBe(workdir.toLowerCase());
});

test("普通项目的子目录不会被误当作默认工作区", () => {
  const workdir = join(root, "workdir");
  const proj = join(root, "work", "app");
  mkdirSync(join(proj, "1789954865560"), { recursive: true });
  mkdirSync(workdir, { recursive: true });

  const idProj = resolveProjectKey(db, proj, { defaultWorkspaceDir: workdir });
  const idSub = resolveProjectKey(db, join(proj, "1789954865560"), {
    defaultWorkspaceDir: workdir,
  });
  // 时间戳子目录只对 defaultWorkspaceDir 生效
  expect(idSub).not.toBe(idProj);
});

// ── 只有项目名时（旧 markdown 目录导入）─────────────────────────────────

test("只有项目名时按 label 命中已有登记项（不重复建）；没登记过的名字新建一条空路径登记项", () => {
  const dir = join(root, "work", "Wa-Pi");
  mkdirSync(dir, { recursive: true });
  const id = resolveProjectKey(db, dir)!;

  // 导入旧 projects-memory/Wa-Pi/ 时只有目录名 → 必须命中同一登记项
  expect(ensureProjectByLabel(db, "Wa-Pi")).toBe(id);
  expect(ensureProjectByLabel(db, "wa-pi")).toBe(id); // 大小写不敏感
  expect(projectRows()).toHaveLength(1);

  // 从未登记过的名字：新建一条 path 为空的登记项（路径未知）
  const other = ensureProjectByLabel(db, "never-seen");
  const row = projectRows().find((r) => r.id === other);
  expect(row?.label).toBe("never-seen");
  expect(row?.path).toBeNull();
  expect(projectRows()).toHaveLength(2);
});

// ── 解析：大小写与路径写法归一 ───────────────────────────────────────────

test("darwin/win32：仅大小写不同的同一路径视为同一个项目", () => {
  const dir = join(root, "work", "Wa-Pi");
  mkdirSync(dir, { recursive: true });

  const a = resolveProjectKey(db, dir, { platform: "darwin" });
  const b = resolveProjectKey(db, dir.toUpperCase(), { platform: "darwin" });
  expect(a).toBe(b);

  // linux：区分大小写，视为不同项目
  const c = resolveProjectKey(db, dir, { platform: "linux" });
  const d = resolveProjectKey(db, dir.toUpperCase(), { platform: "linux" });
  expect(c).not.toBe(d);
});

test("路径写法归一：尾部斜杠与反斜杠不影响身份", () => {
  const dir = join(root, "work", "app");
  mkdirSync(dir, { recursive: true });
  const a = resolveProjectKey(db, dir);
  const b = resolveProjectKey(db, `${dir}${"/"}`);
  expect(a).toBe(b);
});
