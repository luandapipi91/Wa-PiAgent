import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { openKbDb } from "../src/knowledge/kb-db";
import { runIndex, type KbContext, type EmbedFn } from "../src/knowledge/indexer";
import { EMBED_DIM } from "../src/memory/schema";
import { embedFingerprint } from "../src/memory/embedder";
import type { KbProgressEvent } from "@wa-pi/shared";

// 索引编排器测试：注入 fake embed 绕开真实模型（与简报一致：全 128 填充的 768 维向量）。
// 夹具：waPiDir（登记库 + 每库 db）与 srcDir（源文件夹）均为 mkdtemp 临时目录。
// 默认夹具文件 a.md（3 个标题节）+ b.txt（纯文本单块）；特殊夹具在测试内自建。
const fakeEmbed: EmbedFn = async (texts) => texts.map(() => new Uint8Array(EMBED_DIM).fill(128));

let waPiDir: string;
let srcDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;
let kbId: string;
let events: KbProgressEvent[];

beforeEach(() => {
  waPiDir = mkdtempSync(join(tmpdir(), "kb-idx-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-idx-src-"));
  writeFileSync(
    join(srcDir, "a.md"),
    "# A1\n\n内容甲第一段。\n\n# A2\n\n内容乙第二段。\n\n# A3\n\n内容丙第三段。",
  );
  writeFileSync(join(srcDir, "b.txt"), "纯文本备注内容，用于词法检索验证。");
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  events = [];
  ctx = { store, waPiDir, sse: (e) => events.push(e) };
  kbId = store.createKb({ folderPath: srcDir }).id;
});

afterEach(() => {
  reg.close();
  rmSync(waPiDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

/** 打开每库 db 跑断言后立刻关闭（Windows 文件占用：用完自关） */
function withKbDb(fn: (db: Database) => void): void {
  const db = openKbDb(waPiDir, kbId);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function chunkCount(): number {
  let n = 0;
  withKbDb((db) => {
    n = (db.query("SELECT count(*) c FROM chunks").get() as { c: number }).c;
  });
  return n;
}

test("runIndex 全流程：块落库、FTS 双写、向量写入、状态 ready", async () => {
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(store.getKb(kbId)!.status).toBe("ready");
  withKbDb((db) => {
    expect((db.query("SELECT count(*) c FROM chunks").get() as { c: number }).c).toBeGreaterThan(0);
    expect((db.query("SELECT count(*) c FROM chunks_fts").get() as { c: number }).c).toBeGreaterThan(0);
    // 向量全部写入（fake 全 128 向量落 BLOB）
    expect((db.query("SELECT count(*) c FROM chunks WHERE embedding IS NULL").get() as { c: number }).c).toBe(0);
    // FTS body 是 bigram 预处理结果（原文「备注内容」四字连串会被切出「内容」token）
    const fts = db.query("SELECT body FROM chunks_fts LIMIT 1").get() as { body: string };
    expect(fts.body.split(" ")).toContain("内容");
    // 快筛元数据落列：mtime/size 与源文件一致
    const row = db.query("SELECT file_mtime m, file_size s FROM chunks LIMIT 1").get() as { m: number; s: number };
    expect(row.m).toBeGreaterThan(0);
    expect(row.s).toBeGreaterThan(0);
  });
  // 收尾：last_indexed_at 写入 + embed_meta 指纹落库（任务要点）
  const kb = store.getKb(kbId)!;
  expect(kb.lastIndexedAt).toBeGreaterThan(0);
  expect(store.getEmbedMeta(kbId)).toBe(embedFingerprint());
  expect(r.ok).toBe(true);
  expect(r.cancelled).toBe(false);
  expect(store.getJob(kbId)).toBeNull();
});

test("混入损坏 PDF：其余文件完成且 failedCount=1", async () => {
  // 简报夹具语义：broken.pdf + a.md（独立源目录，块数不受共享夹具干扰）
  const src2 = mkdtempSync(join(tmpdir(), "kb-idx-src2-"));
  try {
    writeFileSync(join(src2, "a.md"), "# A1\n\n内容甲。");
    writeFileSync(join(src2, "broken.pdf"), "not a valid pdf content");
    const kb2 = store.createKb({ folderPath: src2 }).id;
    await runIndex(ctx, kb2, fakeEmbed);
    expect(store.getKb(kb2)!.failedCount).toBe(1);
    expect(store.getKb(kb2)!.fileCount).toBe(1);
    expect(store.getKb(kb2)!.status).toBe("ready");
  } finally {
    rmSync(src2, { recursive: true, force: true });
  }
});

test("取消：abort 后状态回到 ready（首次建库则回滚删除全部块）", async () => {
  const ctrl = new AbortController();
  const p = runIndex(ctx, kbId, fakeEmbed, ctrl.signal);
  ctrl.abort();
  await p;
  expect(store.getKb(kbId)!.status).not.toBe("indexing");
  // 首次建库取消：回滚删除全部块与 job，不留半成品
  expect(chunkCount()).toBe(0);
  expect(store.getJob(kbId)).toBeNull();
});

test("更新场景取消：状态恢复 ready，旧块原样保留", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const before = chunkCount();
  writeFileSync(join(srcDir, "c.md"), "# C\n\n取消前新增的文件。");
  const ctrl = new AbortController();
  const p = runIndex(ctx, kbId, fakeEmbed, ctrl.signal);
  ctrl.abort();
  await p;
  expect(store.getKb(kbId)!.status).toBe("ready");
  expect(chunkCount()).toBe(before);
});

test("增量：mtime/size 未变文件跳过，变化文件仅重嵌变化块", async () => {
  const spyEmbed1 = mock(fakeEmbed);
  await runIndex(ctx, kbId, spyEmbed1);
  const calls1 = spyEmbed1.mock.calls.length;
  expect(calls1).toBeGreaterThan(0);
  utimesSync(join(srcDir, "a.md"), new Date(), new Date()); // touch：mtime 变、内容不变
  const spyEmbed2 = mock(fakeEmbed);
  await runIndex(ctx, kbId, spyEmbed2);
  expect(spyEmbed2.mock.calls.length).toBe(0); // 全部未变 → 零嵌入
  writeFileSync(
    join(srcDir, "a.md"),
    "# A1\n\n内容甲第一段。\n\n# A2\n\n内容乙第二段。\n\n# A3\n\n内容丙第三段。\n\n# A4\n\n新增第四节内容。",
  );
  const spyEmbed3 = mock(fakeEmbed);
  await runIndex(ctx, kbId, spyEmbed3);
  expect(spyEmbed3.mock.calls.length).toBeGreaterThan(0); // 仅变化文件重嵌
  // 3 个旧块 contentHash 复用不重嵌，只嵌新增的 A4 一块
  expect(spyEmbed3.mock.calls.flat().length).toBe(1);
});

test("进度持久化：embedding 阶段每批写 job", async () => {
  // 70 个标题节 → 70 块 → 2 批（64+6）；fakeEmbed 探针记录「调用时刻」的已持久化 chunksDone
  for (const f of ["a.md", "b.txt"]) rmSync(join(srcDir, f));
  const sections: string[] = [];
  for (let i = 1; i <= 70; i++) sections.push(`# 节${i}\n\n第${i}节内容段落。`);
  writeFileSync(join(srcDir, "many.md"), sections.join("\n\n"));
  const snapshots: Array<number | null> = [];
  const probe = mock((texts: string[]) => {
    snapshots.push(store.getJob(kbId)?.chunksDone ?? null);
    return fakeEmbed(texts);
  });
  await runIndex(ctx, kbId, probe);
  expect(snapshots.length).toBe(2); // ceil(70/64)
  expect(snapshots[1]).toBe(64); // 第 2 批开跑时第 1 批进度已落库
  expect(store.getJob(kbId)).toBeNull(); // 收尾 job 清除
});

test("嵌入数量不匹配：立刻抛错，首次建库回滚置 error", async () => {
  const bad: EmbedFn = () => Promise.resolve([]);
  await expect(runIndex(ctx, kbId, bad)).rejects.toThrow();
  expect(store.getKb(kbId)!.status).toBe("error");
  expect(chunkCount()).toBe(0);
  expect(store.getJob(kbId)).toBeNull();
});

test("更新失败：旧索引保持可用，status=error", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const before = store.getKb(kbId)!.chunkCount;
  writeFileSync(join(srcDir, "d.md"), "# D\n\n会让嵌入失败的内容。");
  const boom: EmbedFn = () => Promise.reject(new Error("模型炸了"));
  await expect(runIndex(ctx, kbId, boom)).rejects.toThrow("模型炸了");
  expect(store.getKb(kbId)!.status).toBe("error");
  expect(store.getKb(kbId)!.chunkCount).toBe(before); // 旧块未动
  expect(store.getJob(kbId)).toBeNull();
});

test("向量缺失的存量块顺带回填嵌入（规格 §6.2 后台回填）", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  withKbDb((db) => {
    db.run(`UPDATE chunks SET embedding = NULL WHERE file_path = 'b.txt'`);
  });
  const spy = mock(fakeEmbed);
  await runIndex(ctx, kbId, spy);
  // b.txt 快筛命中不重切，但向量缺失 → 回填嵌入；a.md 完好 → 不嵌
  expect(spy.mock.calls.length).toBeGreaterThan(0);
  expect(spy.mock.calls.flat().length).toBe(1);
  withKbDb((db) => {
    expect((db.query("SELECT count(*) c FROM chunks WHERE embedding IS NULL").get() as { c: number }).c).toBe(0);
  });
});

test("删除文件：其块全部移除", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  expect(chunkCount()).toBeGreaterThan(0);
  rmSync(join(srcDir, "b.txt"));
  await runIndex(ctx, kbId, fakeEmbed);
  withKbDb((db) => {
    expect((db.query("SELECT count(*) c FROM chunks WHERE file_path = 'b.txt'").get() as { c: number }).c).toBe(0);
    expect((db.query("SELECT count(*) c FROM chunks WHERE file_path = 'a.md'").get() as { c: number }).c).toBeGreaterThan(0);
  });
  expect(store.getKb(kbId)!.status).toBe("ready");
});

test("SSE 进度事件：knowledge:progress 五阶段推进 + 终态 ready", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.type === "knowledge:progress" && e.kbId === kbId)).toBe(true);
  expect(events.at(-1)!.status).toBe("ready");
  const phases = [...new Set(events.map((e) => e.phase))];
  expect(phases).toContain("scanning");
  expect(phases).toContain("extracting");
  expect(phases).toContain("embedding");
});

test("kb 不存在时抛错", async () => {
  await expect(runIndex(ctx, "no-such-kb", fakeEmbed)).rejects.toThrow();
});
