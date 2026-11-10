import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFolder, scanFolderAsync, isAccessDenied, type ScanFs } from "../src/knowledge/scan";

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

test("docx/pdf 容器格式豁免二进制嗅探：前 512 字节含 0x00 仍可索引", async () => {
  // docx = ZIP 容器（PK\x03\x04 14 00 ...），pdf 的压缩流同样含 0x00——
  // 对这两类声明支持的容器格式做「前 512 字节含 0x00 判二进制」会把整类文件误杀
  const docx = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.alloc(600),
  ]);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(600)]);
  writeFileSync(join(root, "spec.docx"), docx);
  writeFileSync(join(root, "report.pdf"), pdf);

  const p = await scanFolder(root, []);
  const types = new Map(p.indexable.map(f => [f.relPath, f.type]));
  expect(types.get("spec.docx")).toBe("docx");
  expect(types.get("report.pdf")).toBe("pdf");
  // 未识别扩展名/无扩展名仍走嗅探（回归锁：夹具里的 binaryfile 全 0x00）
  expect(p.skips.find(s => s.path === "binaryfile")?.reason).toBe("binary");
});

// ── 异步扫描（scanFolderAsync）───────────────────────────────────────────────
// 60s 轮询快照走异步版，避免大目录扫描阻塞事件循环。两版必须共用同一套谓词与
// 过滤顺序，因此用「逐项相等」锁住：任何一处逻辑漂移都会让下列断言变红。

test("scanFolderAsync 与 scanFolder 结果一致（同一目录逐项相等）", async () => {
  const sync = await scanFolder(root);
  const asyncRes = await scanFolderAsync(root);
  expect(asyncRes.indexable.map(f => f.relPath)).toEqual(sync.indexable.map(f => f.relPath));
  expect(asyncRes.skips.map(s => `${s.path}:${s.reason}`)).toEqual(sync.skips.map(s => `${s.path}:${s.reason}`));
  // 条目全字段相等（type/size/mtime/absPath）：不只是路径对齐，分类与元数据也必须同源
  expect(asyncRes).toEqual(sync);
});

test("scanFolderAsync 同样遵循用户 excludePaths（整棵子树剪掉）", async () => {
  mkdirSync(join(root, "drafts"), { recursive: true });
  writeFileSync(join(root, "drafts", "note.md"), "# 草稿\n待整理内容");
  const sync = await scanFolder(root, ["drafts"]);
  const asyncRes = await scanFolderAsync(root, ["drafts"]);
  expect(asyncRes).toEqual(sync);
  expect(asyncRes.indexable.some(f => f.relPath.startsWith("drafts/"))).toBe(false);
});

test("scanFolderAsync 不跟随符号链接（防逃出源目录边界）", async () => {
  // 源目录外造一个正常 md，再用符号链接指进来：跟随即会多出 linked/secret.md
  const outside = mkdtempSync(join(tmpdir(), "kb-scan-outside-"));
  try {
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "secret.md"), "# 外部文件");
    try {
      symlinkSync(join(outside, "dir"), join(root, "linked"), "dir");
    } catch {
      return; // 平台/权限不允许建链接：跳过该断言（不伪造通过）
    }
    const p = await scanFolderAsync(root);
    expect(p.indexable.some(f => f.relPath.startsWith("linked"))).toBe(false);
    expect(p.skips.some(s => s.path.startsWith("linked"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("excludePaths 可省略（默认空数组）：第 1 层当前未接线，签名保留给后续接入", async () => {
  // 四个调用点（preview/indexer/watcher）都传 []，产品层没有排除入口——
  // 省略参数必须等价于空数组，不能因为「以为已接线」而炸掉
  const p = await scanFolder(root);
  expect(p.indexable.length).toBeGreaterThan(0);
  expect(p.skips.length).toBeGreaterThan(0);
});

// ── 错误归因的等价性保险丝（I-02）───────────────────────────────────────────
// 「两版逐项相等由结构保证」只覆盖过滤链，不覆盖 fs 适配器的错误对象形状：
// skipReasonFor 依赖 err.code，而 EACCES/EPERM 可能来自 stat、open 或 read 阶段，
// 同步版是 throw、异步版是 reject（甚至可能是 AggregateError）。这两条用例用可注入的
// ScanFs 制造错误，锁住「同一错误 → 同一归因 + 同一路径」，两版必须逐项相等。

/** 构造带 code 的错误（模拟 Node 的 ErrnoException 形状） */
function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`注入错误 ${code}`), { code });
}

interface FsFaults {
  /** 指定 absPath 的 stat 抛错 */
  statErr?: Record<string, NodeJS.ErrnoException>;
  /** 指定 absDir 的 readdir 抛错 */
  readdirErr?: Record<string, NodeJS.ErrnoException>;
  /** 指定 absFile 的二进制嗅探（open/read 阶段）抛错 */
  sniffErr?: Record<string, NodeJS.ErrnoException>;
  /** 指定 absPath 的 stat 返回「非常规文件」（模拟遍历中被替换/删除的竞态） */
  notAFile?: Set<string>;
}

/**
 * 真实目录 + 按路径注入错误。shape 决定错误投递方式：
 * sync = 同步 throw（对应 SYNC_FS 的 readdirSync/statSync/openSync），
 * async = rejected Promise（对应 ASYNC_FS 的 fs/promises）。两者都必须走到同一归因。
 */
function faultyFs(shape: "sync" | "async", faults: FsFaults): ScanFs {
  // 异步形状返回 rejected Promise，同步形状直接 throw——错误投递方式不同、判定结果必须相同
  const raise = <T,>(e: Error): T | Promise<T> => {
    if (shape === "async") return Promise.reject<T>(e);
    throw e;
  };
  const readdir = (absDir: string): Dirent[] | Promise<Dirent[]> => {
    const err = faults.readdirErr?.[absDir];
    if (err) return raise(err);
    return shape === "async"
      ? readdirAsync(absDir, { withFileTypes: true })
      : readdirSync(absDir, { withFileTypes: true });
  };
  const stat = (absPath: string): Stats | Promise<Stats> => {
    const err = faults.statErr?.[absPath];
    if (err) return raise(err);
    if (faults.notAFile?.has(absPath)) {
      // 竞态：stat 成功但已不是常规文件（目录替换文件等）→ 扫描应静默忽略
      return Object.assign(statSync(absPath), { isFile: () => false });
    }
    return shape === "async" ? statAsync(absPath) : statSync(absPath);
  };
  // 嗅探只验错误归因：无注入时一律判「非二进制」（夹具里都是文本内容）
  const sniffBinary = (absFile: string): boolean | Promise<boolean> => {
    const err = faults.sniffErr?.[absFile];
    if (err) return raise(err);
    return false;
  };
  return { readdir, stat, sniffBinary };
}

test("错误归因两版一致：EACCES/EPERM → inaccessible，其余读取错误 → unreadable", async () => {
  mkdirSync(join(root, "locked"), { recursive: true });
  const faults: FsFaults = {
    statErr: { [join(root, "a.md")]: errWithCode("EACCES") }, // stat 阶段权限拒绝
    sniffErr: { [join(root, "b.txt")]: errWithCode("ENOTDIR") }, // open/read 阶段非权限错误
    readdirErr: { [join(root, "locked")]: errWithCode("EPERM") }, // 子目录 readdir 权限拒绝
  };
  const sync = await scanFolder(root, [], faultyFs("sync", faults));
  const asyncRes = await scanFolderAsync(root, [], faultyFs("async", faults));
  expect(asyncRes).toEqual(sync); // 同一错误在两版下必须产生同一份清单
  const reasons = Object.fromEntries(sync.skips.map(s => [s.path, s.reason]));
  expect(reasons["a.md"]).toBe("inaccessible");
  expect(reasons["b.txt"]).toBe("unreadable");
  expect(reasons["locked"]).toBe("inaccessible");
});

test("顶层 readdir 失败：两版都向上拒绝，不吞成空清单", async () => {
  const faults: FsFaults = { readdirErr: { [root]: errWithCode("EACCES") } };
  await expect(scanFolder(root, [], faultyFs("sync", faults))).rejects.toThrow("注入错误 EACCES");
  await expect(scanFolderAsync(root, [], faultyFs("async", faults))).rejects.toThrow("注入错误 EACCES");
});

test("stat 后发现已非常规文件：两版都静默忽略（不索引、不记 skip）", async () => {
  const faults: FsFaults = { notAFile: new Set([join(root, "a.md")]) };
  const sync = await scanFolder(root, [], faultyFs("sync", faults));
  const asyncRes = await scanFolderAsync(root, [], faultyFs("async", faults));
  expect(asyncRes).toEqual(sync);
  expect(sync.indexable.some(f => f.relPath === "a.md")).toBe(false);
  expect(sync.skips.some(s => s.path === "a.md")).toBe(false);
});
