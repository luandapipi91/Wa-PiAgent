import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../src/memory/schema";
import { MemoryDao } from "../src/memory/dao";
import { importLegacyMemories } from "../src/memory/import";

let dir: string;
let dao: MemoryDao;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-import-"));
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  dao = new MemoryDao(db);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLegacy(relPath: string, entries: string[], mtime: number) {
  const p = join(dir, relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, entries.join("\n§\n"), "utf8");
  const { utimesSync } = require("node:fs");
  utimesSync(p, mtime / 1000, mtime / 1000);
}

test("导入 global MEMORY.md 与 USER.md，kind/target/scope 正确", async () => {
  writeLegacy("memories/global/MEMORY.md", ["全局笔记 A"], Date.now());
  writeLegacy("memories/global/USER.md", ["用户偏好 B"], Date.now());
  await importLegacyMemories(dir, dao);

  const all = dao.list({ includeArchived: true });
  expect(all).toHaveLength(2);
  const note = all.find((r) => r.content === "全局笔记 A")!;
  const user = all.find((r) => r.content === "用户偏好 B")!;
  expect([note.kind, note.target, note.scope]).toEqual(["knowledge", "memory", "global"]);
  expect([user.kind, user.target, user.scope]).toEqual(["profile", "user", "global"]);
});

test("项目记忆按目录名落入 project scope", async () => {
  writeLegacy("projects-memory/Wa-Pi/MEMORY.md", ["项目约定 C"], Date.now());
  await importLegacyMemories(dir, dao);
  const row = dao.list({ scope: "project" })[0];
  expect(row.projectId).toBe("Wa-Pi");
});

test("文件内顺序决定时间戳：顶部条目最新", async () => {
  const mtime = Date.now();
  writeLegacy("memories/global/MEMORY.md", ["第一条", "第二条", "第三条"], mtime);
  await importLegacyMemories(dir, dao);
  const rows = dao.list({});
  const byContent = Object.fromEntries(rows.map((r) => [r.content, r.createdAt]));
  expect(byContent["第一条"]).toBeGreaterThan(byContent["第二条"]);
  expect(byContent["第二条"]).toBeGreaterThan(byContent["第三条"]);
});

test("导入后原文件重命名为 .imported", async () => {
  writeLegacy("memories/global/MEMORY.md", ["内容 X"], Date.now());
  await importLegacyMemories(dir, dao);
  expect(existsSync(join(dir, "memories/global/MEMORY.md.imported"))).toBe(true);
  expect(existsSync(join(dir, "memories/global/MEMORY.md"))).toBe(false);
});

test("幂等：重复导入不产生重复条目", async () => {
  writeLegacy("memories/global/MEMORY.md", ["只导一次"], Date.now());
  await importLegacyMemories(dir, dao);
  await importLegacyMemories(dir, dao);
  expect(dao.list({ includeArchived: true }).filter((r) => r.content === "只导一次")).toHaveLength(1);
});

test("导入归档 JSON 为 archived=1 条目", async () => {
  writeFileSync(
    join(dir, "memory-archive.json"),
    JSON.stringify({ entries: [{ id: "x", text: "已归档 D", category: "memory", scope: "global", archivedAt: "2026-01-01T00:00:00.000Z" }] }),
    "utf8",
  );
  await importLegacyMemories(dir, dao);
  const row = dao.list({ includeArchived: true }).find((r) => r.content === "已归档 D")!;
  expect(row.archived).toBe(1);
});

test("归档条目的 archivedAt 回填为 sidecar 里的原始时间", async () => {
  // 明显早于现在的固定值：若实现写成迁移当天，断言必红
  const sidecarIso = "2026-01-01T00:00:00.000Z";
  writeFileSync(
    join(dir, "memory-archive.json"),
    JSON.stringify({
      entries: [{ id: "x", text: "历史归档 E", category: "memory", scope: "global", archivedAt: sidecarIso }],
    }),
    "utf8",
  );
  await importLegacyMemories(dir, dao);
  const row = dao.list({ includeArchived: true }).find((r) => r.content === "历史归档 E")!;
  expect(row.archived).toBe(1);
  expect(dao.getById(row.id)!.archivedAt).toBe(Date.parse(sidecarIso));
});

test("普通 markdown 导入的条目 archivedAt 保持 null", async () => {
  writeLegacy("memories/global/MEMORY.md", ["普通笔记 F"], Date.now());
  writeLegacy("memories/global/USER.md", ["普通偏好 G"], Date.now());
  await importLegacyMemories(dir, dao);
  const rows = dao.list({ includeArchived: true });
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.archived).toBe(0);
    expect(dao.getById(r.id)!.archivedAt).toBeNull();
  }
});

test("archivedAt 缺失或非法时回退为迁移时间，不抛错", async () => {
  writeFileSync(
    join(dir, "memory-archive.json"),
    JSON.stringify({
      entries: [
        { id: "a", text: "无法解析时间 H", category: "memory", scope: "global", archivedAt: "not-a-date" },
        { id: "b", text: "缺失时间 I", category: "memory", scope: "global" },
      ],
    }),
    "utf8",
  );
  const before = Date.now();
  await expect(importLegacyMemories(dir, dao)).resolves.toBeUndefined();
  const after = Date.now();
  for (const content of ["无法解析时间 H", "缺失时间 I"]) {
    const row = dao.list({ includeArchived: true }).find((r) => r.content === content)!;
    const readBack = dao.getById(row.id)!;
    expect(readBack.archived).toBe(1);
    expect(readBack.archivedAt!).toBeGreaterThanOrEqual(before);
    expect(readBack.archivedAt!).toBeLessThanOrEqual(after);
  }
});

test("无存量文件时静默返回，不报错", async () => {
  await expect(importLegacyMemories(dir, dao)).resolves.toBeUndefined();
  expect(dao.list({ includeArchived: true })).toHaveLength(0);
});

test("条目可被检索（导入后 FTS 已同步）", async () => {
  writeLegacy("memories/global/MEMORY.md", ["发版必须全量回归"], Date.now());
  await importLegacyMemories(dir, dao);
  expect(dao.search("发版", {})).toHaveLength(1);
});

// ---- 容错边界：kernel 启动时会调用迁移（任务 12 接线），任一来源失败都不得阻断 ----

/** 静音 console.error（避免污染测试输出），并返回捕获到的日志参数列表 */
async function runSilencingErrors(): Promise<unknown[][]> {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await importLegacyMemories(dir, dao);
    // 必须在 mockRestore 之前取走调用记录：restore 会一并清空调用历史
    return spy.mock.calls.map((args) => [...args]);
  } finally {
    spy.mockRestore();
  }
}

test("某个来源读取失败（MEMORY.md 为目录）：该来源跳过且原文件保留原名，其他来源照常导入", async () => {
  // 稳定构造：把 MEMORY.md 做成目录，readFile 对它必抛 EISDIR（不依赖权限位，跨平台一致）
  mkdirSync(join(dir, "memories/global/MEMORY.md"), { recursive: true });
  writeLegacy("memories/global/USER.md", ["故障隔离：偏好仍导入 J"], Date.now());

  const logs = await runSilencingErrors();

  // ① 该来源未导入，且原文件保留原名（未被误重命名）
  expect(existsSync(join(dir, "memories/global/MEMORY.md"))).toBe(true);
  expect(existsSync(join(dir, "memories/global/MEMORY.md.imported"))).toBe(false);
  // ② 其他来源仍正常导入
  expect(dao.list({ includeArchived: true }).map((r) => r.content)).toEqual([
    "故障隔离：偏好仍导入 J",
  ]);
  // ③ 失败留日志（不静默吞），且日志里带上出错路径
  expect(logs.length).toBeGreaterThan(0);
  expect(String(logs[0]![0])).toContain("MEMORY.md");
});

test("projects-memory 读取失败（被做成文件）：跳过项目来源，global 与归档照常导入", async () => {
  // 稳定构造：readdir 对普通文件必抛 ENOTDIR（不依赖权限位，跨平台一致）
  writeFileSync(join(dir, "projects-memory"), "not a directory", "utf8");
  writeLegacy("memories/global/MEMORY.md", ["故障隔离：全局笔记 K"], Date.now());
  writeFileSync(
    join(dir, "memory-archive.json"),
    JSON.stringify({
      entries: [
        {
          id: "x",
          text: "故障隔离：归档 L",
          category: "memory",
          scope: "global",
          archivedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );

  const logs = await runSilencingErrors();

  const contents = dao.list({ includeArchived: true }).map((r) => r.content);
  expect(contents).toHaveLength(2);
  expect(contents).toContain("故障隔离：全局笔记 K");
  expect(contents).toContain("故障隔离：归档 L");
  expect(logs.length).toBeGreaterThan(0);
  expect(String(logs[0]![0])).toContain("projects-memory");
});

test("重命名失败不阻断：原文件保留原名，其他来源照常导入", async () => {
  writeLegacy("memories/global/MEMORY.md", ["故障隔离：改名失败 M"], Date.now());
  writeLegacy("memories/global/USER.md", ["故障隔离：偏好仍导入 N"], Date.now());
  // 稳定构造：把 .imported 目标做成非空目录，rename(文件 → 非空目录) 在 POSIX/Windows 下必失败
  mkdirSync(join(dir, "memories/global/MEMORY.md.imported/keep"), { recursive: true });

  const logs = await runSilencingErrors();

  expect(existsSync(join(dir, "memories/global/MEMORY.md"))).toBe(true);
  expect(dao.list({}).some((r) => r.content === "故障隔离：偏好仍导入 N")).toBe(true);
  expect(logs.length).toBeGreaterThan(0);
  expect(String(logs[0]![0])).toContain("MEMORY.md");
});
