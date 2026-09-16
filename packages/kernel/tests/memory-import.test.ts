import { test, expect, beforeEach, afterEach } from "bun:test";
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

test("无存量文件时静默返回，不报错", async () => {
  await expect(importLegacyMemories(dir, dao)).resolves.toBeUndefined();
  expect(dao.list({ includeArchived: true })).toHaveLength(0);
});

test("条目可被检索（导入后 FTS 已同步）", async () => {
  writeLegacy("memories/global/MEMORY.md", ["发版必须全量回归"], Date.now());
  await importLegacyMemories(dir, dao);
  expect(dao.search("发版", {})).toHaveLength(1);
});
