import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFolder, isAccessDenied } from "../src/knowledge/scan";

// 扫描器测试：mkdtemp 临时夹具（beforeEach 建、afterEach 删），扫描只读、不落任何文件。
// 夹具布局：
//   a.md / b.txt                → indexable
//   .env                        → suggested_excluded
//   big.bin（10MiB+1 全 0x00）  → oversized（大小检查先于 binary 检测，全 0x00 不影响）
//   binaryfile（全 0x00，无扩展名）→ binary
//   node_modules/x.js / keys/server.pem / keys/backup.PEM / notes/MySecret.TXT
//                              → suggested_excluded（后两个为 NTFS 大小写变体）
// drafts/ 只在「用户排除」测试内造：夹具里若是正常 md 会在排除前进 indexable，
// 干扰第一组断言；只有正常文件才能证明是用户排除生效而非建议排除兜底。
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-scan-"));
  writeFileSync(join(root, "a.md"), "# 正文\n产品定价说明段落。");
  writeFileSync(join(root, "b.txt"), "纯文本备注内容");
  writeFileSync(join(root, ".env"), "SECRET_KEY=demo");
  // 10MiB + 1 字节全 0x00：命中 oversized 而非 binary（三层中大小判定在前）
  writeFileSync(join(root, "big.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
  // 无扩展名二进制：前 512B 含 0x00 → binary
  writeFileSync(join(root, "binaryfile"), Buffer.alloc(1024));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "x.js"), "module.exports = 1;");
  mkdirSync(join(root, "keys"));
  writeFileSync(join(root, "keys", "server.pem"), "-----BEGIN PRIVATE KEY-----");
  // NTFS 大小写不敏感：大写变体（.PEM / *secret*）也必须命中建议排除。
  // 注意不能与 server.pem 同名同目录（NTFS 视为同一文件），故用 backup.PEM。
  writeFileSync(join(root, "keys", "backup.PEM"), "-----BEGIN PRIVATE KEY-----");
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes", "MySecret.TXT"), "机密笔记内容");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("scanFolder 三层过滤：建议排除与技术跳过分类正确", async () => {
  const p = await scanFolder(root, []);
  expect(p.indexable.map(f => f.relPath).sort()).toEqual(["a.md", "b.txt"]);
  const reasons = Object.fromEntries(p.skips.map(s => [s.path, s.reason]));
  expect(reasons["node_modules/x.js"]).toBe("suggested_excluded");
  expect(reasons[".env"]).toBe("suggested_excluded");
  expect(reasons["keys/server.pem"]).toBe("suggested_excluded");
  expect(reasons["keys/backup.PEM"]).toBe("suggested_excluded");
  expect(reasons["notes/MySecret.TXT"]).toBe("suggested_excluded");
  expect(reasons["big.bin"]).toBe("oversized");
  // 夹具恰好 7 个跳过条目：防止「该跳的没跳」漏网
  expect(p.skips.length).toBe(7);
  expect(reasons["binaryfile"]).toBe("binary");
});

test("用户 excludePaths 显式排除整棵子树", async () => {
  mkdirSync(join(root, "drafts"), { recursive: true });
  writeFileSync(join(root, "drafts", "note.md"), "# 草稿\n待整理内容");
  // 对照：无排除时草稿可索引（证明后续消失确系用户排除生效）
  expect((await scanFolder(root, [])).indexable.some(f => f.relPath.startsWith("drafts/"))).toBe(true);
  const p = await scanFolder(root, ["drafts"]);
  expect(p.indexable.some(f => f.relPath.startsWith("drafts/"))).toBe(false);
});

test("扫描不写入源目录", async () => {
  const before = readdirSync(root);
  await scanFolder(root, []);
  expect(readdirSync(root)).toEqual(before);
});

test("isAccessDenied 契约：EACCES/EPERM 归 inaccessible，其余错误归 unreadable", () => {
  expect(isAccessDenied({ code: "EACCES" })).toBe(true);
  expect(isAccessDenied({ code: "EPERM" })).toBe(true);
  expect(isAccessDenied({ code: "ENOENT" })).toBe(false);
  expect(isAccessDenied(new Error("io"))).toBe(false);
});

test("indexable 条目携带 type/size/mtime 且 relPath 为 POSIX 风格", async () => {
  const p = await scanFolder(root, []);
  const a = p.indexable.find(f => f.relPath === "a.md")!;
  expect(a.type).toBe("md");
  expect(a.size).toBeGreaterThan(0);
  expect(a.mtime).toBeGreaterThan(0);
  expect(a.absPath).toBe(join(root, "a.md"));
  const b = p.indexable.find(f => f.relPath === "b.txt")!;
  expect(b.type).toBe("txt");
});
