import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { closeAllKbDbs, openKbDb } from "../src/knowledge/kb-db";
import { kbQuantizedScan } from "../src/knowledge/vector";
import {
  runIndex,
  wrapEmbedWithYield,
  EMBED_YIELD_SUB_BATCH,
  type KbContext,
  type EmbedFn,
} from "../src/knowledge/indexer";
import { KB_CHUNKER_VERSION, knowledgeFingerprint } from "../src/knowledge/fingerprint";
import { EMBED_DIM } from "../src/memory/schema";
import { embedderKeepAliveCountForTest } from "../src/memory/embedder";
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
  closeAllKbDbs(); // 每库连接归缓存所有，用例间必须归位
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
  expect(store.getEmbedMeta(kbId)).toBe(knowledgeFingerprint());
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
  // 外部批仍按 64 记账（2 批），但推理按子批 4 切碎让出 → 共 18 次调用（16 + 2）
  expect(snapshots.length).toBe(18);
  expect(snapshots[16]).toBe(64); // 外部第 2 批开跑时第 1 批进度已落库
  expect(snapshots.slice(0, 16).every((v) => v === null)).toBe(true); // 第 1 批未收尾前不写 chunksDone
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

test("嵌入按子批让出：外部批被切碎，顺序与数量不变（主线程不被单批推理长时间占死）", async () => {
  const calls: number[] = [];
  // 用索引编码返回值，验证子批拼接后顺序不串
  const probe: EmbedFn = async (texts) => {
    calls.push(texts.length);
    return texts.map((t) => new Uint8Array([Number(t.slice(1))]));
  };
  const wrapped = wrapEmbedWithYield(probe);
  const texts = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const out = await wrapped(texts);
  expect(calls).toEqual([4, 4, 4, 4, 4]);
  expect(out.map((v) => v[0])).toEqual(texts.map((_, i) => i));
});

test("子批之间让出事件循环：让出窗口内排队的宏任务先于下一子批执行", async () => {
  let ticked = 0;
  const seen: number[] = [];
  const probe: EmbedFn = async (texts) => {
    seen.push(ticked);
    if (seen.length === 1) setTimeout(() => ticked++, 0);
    return texts.map(() => new Uint8Array(EMBED_DIM).fill(1));
  };
  const wrapped = wrapEmbedWithYield(probe);
  await wrapped(Array.from({ length: 20 }, (_, i) => `t${i}`));
  // 第一个子批之后，每进入下一个子批时 timer 都已跑过（中间确实让出了事件循环）
  expect(seen.slice(1).every((v) => v === 1)).toBe(true);
});

test("子批让出后响应取消：signal 已中止则下一次让出即抛错", async () => {
  const controller = new AbortController();
  const probe: EmbedFn = async (texts) => {
    controller.abort(); // 第一批完成后取消
    return texts.map(() => new Uint8Array(EMBED_DIM).fill(1));
  };
  const wrapped = wrapEmbedWithYield(probe, undefined, controller.signal);
  await expect(wrapped(Array.from({ length: 20 }, (_, i) => `t${i}`))).rejects.toThrow("索引已取消");
});

test("索引默认走子批让出（外部包 64 条时实际推理调用不超过子批上限）", async () => {
  // 70 块 → 外部 2 批（64+6）→ 子批切分成 [4×16, 4+2]
  for (const f of ["a.md", "b.txt"]) rmSync(join(srcDir, f));
  const sections: string[] = [];
  for (let i = 1; i <= 70; i++) sections.push(`# 节${i}\n\n第${i}节内容段落。`);
  writeFileSync(join(srcDir, "many.md"), sections.join("\n\n"));
  const sizes: number[] = [];
  const probe: EmbedFn = async (texts) => {
    sizes.push(texts.length);
    return fakeEmbed(texts);
  };
  await runIndex(ctx, kbId, probe);
  expect(sizes.length).toBe(18);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(EMBED_YIELD_SUB_BATCH);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(70);
});

test("进度事件带 chunksTotal：embedding 阶段暴露块总量，逐批追平（进度条要真实推进）", async () => {
  const probe = mock(fakeEmbed);
  await runIndex(ctx, kbId, probe);
  const total = probe.mock.calls.reduce((sum, call) => sum + call[0].length, 0);
  expect(total).toBeGreaterThan(0);
  const embeddingFrames = events.filter((e) => e.phase === "embedding" && e.status === "indexing");
  expect(embeddingFrames.length).toBeGreaterThan(0);
  // 嵌入阶段每一帧都带块总量（前端据此算 0→100 的推进，而不是用文件数冒充）
  expect(embeddingFrames.every((e) => e.chunksTotal === total)).toBe(true);
  // 首帧 chunksDone=0，末帧追平总量
  expect(embeddingFrames[0].chunksDone).toBe(0);
  expect(embeddingFrames.at(-1)!.chunksDone).toBe(total);
  // 嵌入之前的阶段没有块总量可言，显式给 0（避免前端拿到 undefined 又要分支）
  expect(
    events.filter((e) => e.phase === "scanning" || e.phase === "extracting").every((e) => e.chunksTotal === 0),
  ).toBe(true);
});

test("job 行同步持久化 chunksTotal（刷新/断连后快照也能算真实进度）", async () => {
  const snapshots: Array<number | null> = [];
  const probe: EmbedFn = async (texts) => {
    snapshots.push(store.getJob(kbId)?.chunksTotal ?? null);
    return fakeEmbed(texts);
  };
  await runIndex(ctx, kbId, probe);
  expect(snapshots.length).toBeGreaterThan(0);
  // 嵌入开始前 job 行已写入块总量（每批开跑时都能读到）
  expect(snapshots.every((v) => v !== null && v > 0)).toBe(true);
});

test("索引全程持有 embedder 保活引用：抽取/嵌入期间模型不会被空闲卸载", async () => {
  const seen: number[] = [];
  const probe: EmbedFn = async (texts) => {
    seen.push(embedderKeepAliveCountForTest());
    return fakeEmbed(texts);
  };
  await runIndex(ctx, kbId, probe);
  expect(seen.length).toBeGreaterThan(0);
  // 嵌入调用发生时就已持有保活（索引开始即 acquire，覆盖抽取阶段的长时间不调嵌入）
  expect(seen.every((n) => n >= 1)).toBe(true);
});

test("索引收尾释放保活引用（成功/失败都不泄漏）", async () => {
  const before = embedderKeepAliveCountForTest();
  await runIndex(ctx, kbId, fakeEmbed);
  expect(embedderKeepAliveCountForTest()).toBe(before);
  // 失败路径：环境异常（这里用空嵌入触发数量不匹配）也要释放
  writeFileSync(join(srcDir, "c.md"), "# C\n\n新增内容。");
  const bad: EmbedFn = () => Promise.resolve([]);
  await expect(runIndex(ctx, kbId, bad)).rejects.toThrow();
  expect(embedderKeepAliveCountForTest()).toBe(before);
});

test("commit 中途失败：单事务回滚，旧块零丢失（更新失败旧数据不动）", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const before = chunkCount();
  // 记录旧块指纹：失败后必须原样还在（旧块未被部分应用式替换）
  let oldHashes: string[] = [];
  withKbDb((db) => {
    oldHashes = (db.query("SELECT content_hash h FROM chunks ORDER BY h").all() as Array<{ h: string }>).map((r) => r.h);
  });
  // 造变化文件（a.md 重写）+ 新文件（d.md）→ 两者都在 commit 事务内
  writeFileSync(join(srcDir, "a.md"), "# A1\n\n改过的内容甲。\n\n# A2\n\n改过的内容乙。");
  writeFileSync(join(srcDir, "d.md"), "# D\n\n新文件内容。");
  // 注入 commit 期故障：插 d.md 块时 ABORT（触发器在库文件内持久，runIndex 的新连接可见）
  withKbDb((db) => {
    db.run(
      `CREATE TRIGGER fail_commit BEFORE INSERT ON chunks
       WHEN NEW.file_path = 'd.md'
       BEGIN SELECT RAISE(ABORT, '注入的 commit 失败'); END;`,
    );
  });
  await expect(runIndex(ctx, kbId, fakeEmbed)).rejects.toThrow("注入的 commit 失败");
  expect(store.getKb(kbId)!.status).toBe("error");
  expect(store.getJob(kbId)).toBeNull();
  // 单事务 ROLLBACK：a.md 旧块仍在（内容 hash 不变）、无 d.md 块、总数不变
  expect(chunkCount()).toBe(before);
  withKbDb((db) => {
    const hashes = (db.query("SELECT content_hash h FROM chunks ORDER BY h").all() as Array<{ h: string }>).map((r) => r.h);
    expect(hashes).toEqual(oldHashes);
    expect((db.query("SELECT count(*) c FROM chunks WHERE file_path = 'd.md'").get() as { c: number }).c).toBe(0);
  });
  // 故障排除后重建可成功（触发器随测试夹具清理消失）
  rmSync(join(srcDir, "d.md"));
  await runIndex(ctx, kbId, fakeEmbed);
  expect(store.getKb(kbId)!.status).toBe("ready");
});

test("重入防护：已有活动 job 时二次 runIndex 被拒", async () => {
  // 模拟另一入口（watcher/工具/路由）已启动索引
  store.startJob(kbId, "scanning");
  await expect(runIndex(ctx, kbId, fakeEmbed)).rejects.toThrow("拒绝重入");
  // 防护发生在状态改写之前：status 未被污染成 indexing
  expect(store.getKb(kbId)!.status).toBe("scanning");
  // job 清理后不再误伤
  store.finishJob(kbId);
  await runIndex(ctx, kbId, fakeEmbed);
  expect(store.getKb(kbId)!.status).toBe("ready");
});

test("kb 不存在时抛错", async () => {
  await expect(runIndex(ctx, "no-such-kb", fakeEmbed)).rejects.toThrow();
});

test("mtime 变但内容不变（行重建、hash 全复用）也刷新量化索引：语义通道仍能命中", async () => {
  // 量化要求合法 float32 向量（Uint8Array.fill(128) 是字节填充，会被扩展判为非法 blob）
  const floatEmbed: EmbedFn = async (texts) =>
    texts.map(() => new Uint8Array(new Float32Array(new Array(EMBED_DIM).fill(0.1)).buffer));
  await runIndex(ctx, kbId, floatEmbed);
  // touch：mtime 变、size 与内容不变 → 快筛不命中 → 重切块 → contentHash 全复用（needEmbed=0）
  // 但 commit 仍删除并重建行（rowid 变化），量化 shadow 按 rowid JOIN，不刷新就会错位
  const t = Date.now() / 1000 + 5;
  utimesSync(join(srcDir, "a.md"), t, t);
  const r2 = await runIndex(ctx, kbId, floatEmbed);
  expect(r2.ok).toBe(true);
  withKbDb((db) => {
    const vec = new Uint8Array(new Float32Array(new Array(EMBED_DIM).fill(0.1)).buffer);
    const hits = kbQuantizedScan(db, vec, 50);
    // 全部块都必须能被量化扫描覆盖：a.md 的行被删后重插（rowid 变化），
    // shadow 不重建会让它的块从语义通道里消失（只剩 b.txt 的块）
    expect(hits.length).toBe(chunkCount());
    expect(chunkCount()).toBeGreaterThan(1);
  });
});

test("扫描结果归零突变拒绝本轮：目录瞬时挂空不删存量块，置 error", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const before = chunkCount();
  expect(before).toBeGreaterThan(0);
  // 模拟「网络盘/外置卷瞬时挂成空目录」：readdirSync 成功返回 0 项，不抛错
  for (const f of readdirSync(srcDir)) unlinkSync(join(srcDir, f));
  await expect(runIndex(ctx, kbId, fakeEmbed)).rejects.toThrow(/归零|为空/);
  // 存量块不得被删（修复前会被当成「所有文件都已删除」全删并置 ready）
  expect(chunkCount()).toBe(before);
  const kb = store.getKb(kbId)!;
  expect(kb.status).toBe("error");
  expect(kb.chunkCount).toBe(before);
});

test("索引失败原因持久化到 KbInfo.lastError（失败写入、成功清空）", async () => {
  const boom: EmbedFn = async () => {
    throw new Error("模型加载失败 model exploded");
  };
  await expect(runIndex(ctx, kbId, boom)).rejects.toThrow(/model exploded/);
  const failed = store.getKb(kbId)!;
  expect(failed.status).toBe("error");
  // 失败原因必须能被界面读到（此前只进 console.warn，用户只看到「索引中断」四个字）
  expect(failed.lastError).toContain("model exploded");
  // 成功一轮后清空（避免旧错误长期挂在就绪库上误导）
  await runIndex(ctx, kbId, fakeEmbed);
  expect(store.getKb(kbId)!.lastError ?? null).toBeNull();
});

test("切块版本进 embed_meta 指纹：chunker 版本变化会触发全量重建", async () => {
  await runIndex(ctx, kbId, fakeEmbed);
  const meta = store.getEmbedMeta(kbId)!;
  expect(meta).toContain(`chunker=${KB_CHUNKER_VERSION}`);
  expect(meta).toBe(knowledgeFingerprint());
});
