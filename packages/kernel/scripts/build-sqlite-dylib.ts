// 编译 vanilla SQLite dylib（macOS 专用）——bun:sqlite 在 macOS 上用 Apple 专有构建，
// 不支持动态扩展加载（sqlite-vector 语义检索的前提），需用 Database.setCustomSQLite()
// 切换到标准构建。本脚本从 sqlite.org 下载 amalgamation 源码，用系统 clang 编译出 dylib。
//
// 用法：bun run scripts/build-sqlite-dylib.ts [--force]
// 产物：packages/kernel/assets/sqlite/libsqlite3.dylib（不入库，gitignore）
//
// flags 口径：覆盖 bun 内嵌构建的特性面（FTS5 是词法检索 memories_fts 的硬依赖），
// 与 Homebrew sqlite 构建口径对齐。
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SQLITE_VERSION = "3.53.4";
const AMALG_VERSION = "3530400"; // 3.53.4 → 3530400
const YEAR_DIR = "2026";
const URL = `https://www.sqlite.org/${YEAR_DIR}/sqlite-amalgamation-${AMALG_VERSION}.zip`;

const kernelDir = join(import.meta.dir, "..");
const outDir = join(kernelDir, "assets", "sqlite");
const outDylib = join(outDir, "libsqlite3.dylib");

const force = process.argv.includes("--force");
if (existsSync(outDylib) && !force) {
  console.log(`已存在：${outDylib}（--force 重新编译）`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.error("仅 macOS 需要（Windows/Linux 的 bun 构建原生支持扩展加载）");
  process.exit(1);
}

const tmpDir = join(outDir, `.build-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
try {
  console.log(`下载 ${URL} ...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const zipPath = join(tmpDir, "amalgamation.zip");
  await Bun.write(zipPath, res);

  console.log("解压 ...");
  const proc = Bun.spawnSync(["unzip", "-oq", zipPath, "-d", tmpDir]);
  if (proc.exitCode !== 0) throw new Error(`解压失败：${proc.stderr.toString()}`);

  const srcDir = join(tmpDir, `sqlite-amalgamation-${AMALG_VERSION}`);
  console.log("编译 ...");
  const flags = [
    "-DSQLITE_ENABLE_COLUMN_METADATA",
    "-DSQLITE_ENABLE_DBSTAT_VTAB",
    "-DSQLITE_ENABLE_FTS3_PARENTHESIS",
    "-DSQLITE_ENABLE_FTS4",
    "-DSQLITE_ENABLE_FTS5",
    "-DSQLITE_ENABLE_JSON1",
    "-DSQLITE_ENABLE_MATH_FUNCTIONS",
    "-DSQLITE_ENABLE_RTREE",
    "-DSQLITE_ENABLE_UNLOCK_NOTIFY",
    "-DSQLITE_SOUNDEX",
    "-DSQLITE_ENABLE_EXPLAIN_COMMENTS",
    "-DSQLITE_THREADSAFE=1",
    "-DHAVE_USLEEP=1",
  ];
  const cc = Bun.spawnSync(
    ["clang", "-dynamiclib", join(srcDir, "sqlite3.c"), "-o", outDylib, ...flags, "-O2", "-fPIC", `-install_name`, outDylib],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (cc.exitCode !== 0) throw new Error(`编译失败：\n${cc.stderr.toString()}`);

  console.log(`✅ 产物：${outDylib}`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
