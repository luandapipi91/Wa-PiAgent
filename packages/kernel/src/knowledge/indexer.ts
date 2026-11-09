// 知识库索引编排器：五阶段状态机（扫描→抽取→切块→嵌入→落库）+ 进度持久化 + SSE + 取消 + 回滚。
// 编排 scanFolder（任务 3）/ extractText（任务 4）/ chunkDocument（任务 5）的产物，
// 落库到 KnowledgeStore（任务 2）登记层与每库独立 db（chunks + chunks_fts 双写）。
//
// 增量（规格 §6.3）：file_path + mtime + size 快筛命中整文件跳过；变化文件重切块后逐块比对
// content_hash——相同复用旧块（保留 id 与向量，不重嵌）；未被认领的旧块删除；已删除文件的块全部移除。
// 回填（规格 §6.2）：库级 embed_meta 指纹不匹配或块向量缺失时，快筛命中的存量块顺带重嵌（不重读文件）。
//
// 失败/取消语义（规格 §6.3 + 控制者简报）：
//   - 首次建库（last_indexed_at 为空）失败或取消：删该库全部块与 job，失败置 error、取消恢复原状态；
//   - 更新失败：嵌入期失败时 chunks 表未动（旧索引保持可用）；commit 逐文件事务，已完成文件一致保留；
//   - 更新取消：恢复原状态（ready），已完成部分保留（每文件事务，数据始终一致）。
// 量化索引刷新沿用 memory/vector-index.ts 的 finish 模式：本轮写过/删过向量才在收尾刷一次
// （vector_quantize 是 O(N) 全量重建，逐批刷新会把后台任务变成持续 CPU 占用）。
import type { Database } from "bun:sqlite";
import type { KbInfo } from "@wa-pi/shared";
import { bigram } from "../memory/bigram";
import { embedDocuments, embedFingerprint } from "../memory/embedder";
import { scanFolder } from "./scan";
import { extractText } from "./extract";
import { chunkDocument, type KnowledgeChunk } from "./chunker";
import { openKbDb } from "./kb-db";
import { refreshKbQuantizedIndex } from "./vector";
import type { KbContext } from "./index";

type KbPhase = NonNullable<KbInfo["progress"]>["phase"];
type KbStatus = KbInfo["status"];

// KbContext 定义在桶导出（任务 7/11 复用）；此处重导出让调用方从任一入口导入都可行
export type { KbContext } from "./index";

/** 嵌入与进度批大小（规格硬性：批 64，批间让出事件循环） */
export const INDEX_BATCH = 64;

/** 嵌入函数形状：缺省用真实 embedDocuments，测试注入 fake 绕开模型 */
export type EmbedFn = (texts: string[]) => Promise<Uint8Array[]>;

/** 一轮索引的结果（取消/失败不抛错取消——取消正常返回，真失败抛错） */
export interface IndexResult {
  ok: boolean;
  cancelled: boolean;
  filesTotal: number;
  filesDone: number;
  chunkCount: number;
  failedCount: number;
}

/** 存量块快照（增量判定底料）：id + contentHash + 现有向量 + 嵌入输入源 */
interface ExistingChunk {
  id: string;
  hash: string;
  embedding: Uint8Array | null;
  prefixContent: string;
}

/** 存量文件快照：快筛元数据 + 按块 */
interface ExistingFile {
  mtime: number;
  size: number;
  chunks: ExistingChunk[];
  byHash: Map<string, ExistingChunk>;
}

/** 存量快照集合：按文件路径与按块 id 两种索引 */
interface ExistingSnapshot {
  byPath: Map<string, ExistingFile>;
  byId: Map<string, ExistingChunk>;
}

/** 变化文件的落库计划：重切块 + 逐块去向（复用旧向量 / 待嵌入） */
interface FilePlan {
  relPath: string;
  mtime: number;
  size: number;
  fileType: string;
  chunks: KnowledgeChunk[];
  /** 旧文件是否存在（存在则 commit 时先删旧块） */
  hasOld: boolean;
  /** chunk 索引 → 复用的旧块（保留 id 与向量，不重嵌）；未命中则待嵌入 */
  reuse: Map<number, ExistingChunk>;
}

/** 待嵌入项：新块（commit 时 INSERT）或回填块（UPDATE 既有行） */
interface EmbedItem {
  prefixContent: string;
  chunk?: KnowledgeChunk;
  /** 回填项的既有行 id */
  backfillId?: string;
  vec?: Uint8Array;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("索引已取消");
}

/** SSE 广播；回调异常不阻断索引 */
function emit(
  ctx: KbContext,
  kbId: string,
  phase: KbPhase,
  status: KbStatus,
  filesTotal: number,
  filesDone: number,
  chunksDone: number,
): void {
  try {
    ctx.sse({ type: "knowledge:progress", kbId, phase, status, filesTotal, filesDone, chunksDone });
  } catch {
    /* 广播失败不影响索引推进 */
  }
}

/** 读全部存量块为增量判定快照（块量万级，全表一次拉回内存对比最简单可靠） */
function loadExisting(db: Database): ExistingSnapshot {
  const rows = db
    .query(`SELECT id, file_path, content_hash, prefix_content, file_mtime, file_size, embedding FROM chunks`)
    .all() as Array<{
    id: string;
    file_path: string;
    content_hash: string;
    prefix_content: string;
    file_mtime: number;
    file_size: number;
    embedding: Uint8Array | null;
  }>;
  const snapshot: ExistingSnapshot = { byPath: new Map(), byId: new Map() };
  for (const r of rows) {
    let f = snapshot.byPath.get(r.file_path);
    if (!f) {
      f = { mtime: r.file_mtime, size: r.file_size, chunks: [], byHash: new Map() };
      snapshot.byPath.set(r.file_path, f);
    }
    const c: ExistingChunk = { id: r.id, hash: r.content_hash, embedding: r.embedding, prefixContent: r.prefix_content };
    f.chunks.push(c);
    f.byHash.set(c.hash, c);
    snapshot.byId.set(c.id, c);
  }
  return snapshot;
}

/**
 * 跑一轮完整索引。embedFn 缺省用真实 embedDocuments；signal 提供时在阶段边界与批间检查取消。
 * 取消正常返回（cancelled=true）；真失败抛错（数量不匹配/写库失败/模型异常等）。
 */
export async function runIndex(
  ctx: KbContext,
  kbId: string,
  embedFn: EmbedFn = embedDocuments,
  signal?: AbortSignal,
): Promise<IndexResult> {
  const kb = ctx.store.getKb(kbId);
  if (!kb) throw new Error(`知识库不存在：${kbId}`);
  const prevStatus = kb.status;
  const firstRun = kb.lastIndexedAt === null;
  const fingerprint = embedFingerprint();
  // 库级指纹不匹配 = 存量向量全部过期（规格 §6.2）：视为未索引，快筛短路失效、hash 复用只留行不重嵌。
  // 指纹从登记库直读（KbInfo 投影不含 embed_meta）——从未索引过为 null，null 不算不匹配。
  const storedMeta = ctx.store.getEmbedMeta(kbId);
  const fingerprintMismatch = storedMeta !== null && storedMeta !== fingerprint;

  ctx.store.startJob(kbId, "scanning");
  ctx.store.updateStatus(kbId, "indexing");
  emit(ctx, kbId, "scanning", "indexing", kb.fileCount, 0, 0);

  let filesTotal = 0;
  let filesDone = 0;
  let failedCount = 0;
  let chunksDone = 0;

  const db = openKbDb(ctx.waPiDir, kbId);
  try {
    // ===== 阶段 1：扫描（先数不写，复用任务 3）=====
    throwIfAborted(signal);
    const preview = await scanFolder(kb.folderPath, []);
    filesTotal = preview.indexable.length;
    const skipStats: Record<string, number> = {};
    for (const s of preview.skips) skipStats[s.reason] = (skipStats[s.reason] ?? 0) + 1;
    ctx.store.updateJobProgress(kbId, { filesTotal, skipStats });
    emit(ctx, kbId, "scanning", "indexing", filesTotal, 0, 0);

    const existing = loadExisting(db);

    // ===== 阶段 2/3：抽取 + 切块（全部在内存完成，落库推迟到 commit——commit 前不对外可见）=====
    const plans: FilePlan[] = [];
    const keptFileIds: string[] = []; // 快筛命中文件的块 id（保留行，可能需回填向量）
    for (const file of preview.indexable) {
      throwIfAborted(signal);
      const old = existing.byPath.get(file.relPath);
      if (old && !fingerprintMismatch && old.mtime === file.mtime && old.size === file.size) {
        // 快筛命中：整文件原样保留（不重读、不重切、不重嵌）
        for (const c of old.chunks) keptFileIds.push(c.id);
        filesDone++;
        continue;
      }
      let text: string;
      try {
        text = (await extractText(file.absPath, file.type)).text;
      } catch {
        // 单文件失败不拖垮整轮（规格 §6.3）；extraction_failed 由抽取阶段产生，计入跳过统计
        failedCount++;
        skipStats.extraction_failed = (skipStats.extraction_failed ?? 0) + 1;
        filesDone++;
        ctx.store.updateJobProgress(kbId, { phase: "extracting", filesDone, skipStats: { ...skipStats } });
        emit(ctx, kbId, "extracting", "indexing", filesTotal, filesDone, 0);
        continue;
      }
      const chunks = chunkDocument({ type: file.type, text, relPath: file.relPath });
      const plan: FilePlan = {
        relPath: file.relPath,
        mtime: file.mtime,
        size: file.size,
        fileType: file.type,
        chunks,
        hasOld: old !== undefined,
        reuse: new Map(),
      };
      for (let i = 0; i < chunks.length; i++) {
        const hit = old?.byHash.get(chunks[i].contentHash);
        // 指纹不匹配时旧向量无效：只保留行 id（commit 时以新向量覆盖写入），不入复用
        if (hit && !fingerprintMismatch && hit.embedding !== null) plan.reuse.set(i, hit);
      }
      plans.push(plan);
      filesDone++;
      ctx.store.updateJobProgress(kbId, { phase: "extracting", filesDone, skipStats: { ...skipStats } });
      emit(ctx, kbId, "extracting", "indexing", filesTotal, filesDone, 0);
    }

    // ===== 阶段 4：嵌入（批 64，批间让出事件循环；数量不匹配立刻抛错）=====
    const needEmbed: EmbedItem[] = [];
    for (const plan of plans) {
      for (let i = 0; i < plan.chunks.length; i++) {
        if (!plan.reuse.has(i)) needEmbed.push({ prefixContent: plan.chunks[i].prefixContent, chunk: plan.chunks[i] });
      }
    }
    const vecByChunk = new Map<KnowledgeChunk, Uint8Array>(); // 嵌入完成后块 → 向量（commit 时 O(1) 取用）
    // 回填：快筛命中文件的存量块——向量缺失，或指纹不匹配（全量过期）
    for (const id of keptFileIds) {
      const c = existing.byId.get(id);
      if (c && (fingerprintMismatch || c.embedding === null)) {
        needEmbed.push({ prefixContent: c.prefixContent, backfillId: c.id });
      }
    }
    ctx.store.updateJobProgress(kbId, { phase: "embedding" });
    emit(ctx, kbId, "embedding", "indexing", filesTotal, filesDone, 0);
    for (let i = 0; i < needEmbed.length; i += INDEX_BATCH) {
      throwIfAborted(signal);
      const batch = needEmbed.slice(i, i + INDEX_BATCH);
      const vecs = await embedFn(batch.map((b) => b.prefixContent));
      if (vecs.length !== batch.length) {
        throw new Error(`嵌入数量不匹配：期望 ${batch.length}，实际 ${vecs.length}`);
      }
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        item.vec = vecs[j];
        if (item.chunk) vecByChunk.set(item.chunk, vecs[j]);
      }
      chunksDone += batch.length;
      ctx.store.updateJobProgress(kbId, { phase: "embedding", chunksDone });
      emit(ctx, kbId, "embedding", "indexing", filesTotal, filesDone, chunksDone);
      // 让出事件循环（桌面 UI 不卡；规格 §6.3 硬性要求）
      await new Promise((r) => setTimeout(r, 0));
    }

    // ===== 阶段 5：落库（逐文件事务：FTS 应用层同事务双写，不用触发器——规格 §6.1）=====
    throwIfAborted(signal);
    ctx.store.updateJobProgress(kbId, { phase: "committing" });
    emit(ctx, kbId, "committing", "indexing", filesTotal, filesDone, chunksDone);
    const nowPaths = new Set(preview.indexable.map((f) => f.relPath));
    const removedPaths: string[] = [];
    for (const [path] of existing.byPath) if (!nowPaths.has(path)) removedPaths.push(path);

    const insertChunk = db.transaction((plan: FilePlan) => {
      if (plan.hasOld) {
        // 先删 FTS（子查询依赖 chunks 行）再删块
        db.run(`DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)`, [plan.relPath]);
        db.run(`DELETE FROM chunks WHERE file_path = ?`, [plan.relPath]);
      }
      const now = Date.now();
      for (let i = 0; i < plan.chunks.length; i++) {
        const c = plan.chunks[i];
        const reuse = plan.reuse.get(i);
        const id = reuse?.id ?? c.id;
        const embedding = reuse?.embedding ?? vecByChunk.get(c) ?? null;
        db.run(
          `INSERT INTO chunks (id, file_path, file_type, title, breadcrumb, start_line, end_line,
             content, prefix_content, content_hash, file_mtime, file_size, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, c.relPath, c.fileType, c.title ?? null, c.breadcrumb ?? null,
            c.startLine, c.endLine, c.content, c.prefixContent, c.contentHash,
            plan.mtime, plan.size, embedding, now,
          ],
        );
        db.run(`INSERT INTO chunks_fts (body, chunk_id) VALUES (?, ?)`, [bigram(c.prefixContent), id]);
      }
    });
    const removeFile = db.transaction((relPath: string) => {
      db.run(`DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)`, [relPath]);
      db.run(`DELETE FROM chunks WHERE file_path = ?`, [relPath]);
    });
    const backfillAll = db.transaction((items: EmbedItem[]) => {
      for (const b of items) {
        // 嵌入批完成后 vec 必已就位（backfills 过滤过 backfillId）
        db.run(`UPDATE chunks SET embedding = ? WHERE id = ?`, [b.vec as Uint8Array, b.backfillId as string]);
      }
    });

    for (const plan of plans) {
      throwIfAborted(signal);
      insertChunk(plan);
    }
    for (const relPath of removedPaths) {
      throwIfAborted(signal);
      removeFile(relPath);
    }
    const backfills = needEmbed.filter((b) => b.backfillId !== undefined);
    if (backfills.length > 0) backfillAll(backfills);

    // ===== 收尾：counters + last_indexed_at + embed_meta（任务要点）+ job 清除 + 量化刷新 =====
    const { c: chunkTotal } = db.query(`SELECT COUNT(*) c FROM chunks`).get() as { c: number };
    const fileCount = filesTotal - failedCount;
    ctx.store.updateStatus(kbId, "ready", {
      fileCount,
      chunkCount: chunkTotal,
      failedCount,
      embedMeta: fingerprint,
      lastIndexedAt: Date.now(),
    });
    ctx.store.finishJob(kbId);
    emit(ctx, kbId, "committing", "ready", filesTotal, filesDone, chunksDone);
    // 本轮写过或删过向量才刷量化索引（O(N) 全量重建，沿用 memory finish 模式）
    if (needEmbed.length > 0 || removedPaths.length > 0) refreshKbQuantizedIndex(db);

    return { ok: true, cancelled: false, filesTotal, filesDone, chunkCount: chunkTotal, failedCount };
  } catch (err) {
    const cancelled = signal?.aborted === true;
    if (firstRun) {
      // 首次建库（取消或失败）：删该库全部块，不留半成品
      db.run(`DELETE FROM chunks_fts`);
      db.run(`DELETE FROM chunks`);
      refreshKbQuantizedIndex(db);
    }
    ctx.store.finishJob(kbId);
    if (cancelled) {
      // 取消：恢复原状态（新建库 prevStatus=scanning；同库单 job 下 prevStatus 不会是 indexing）
      const restore: KbStatus = prevStatus === "indexing" ? "scanning" : prevStatus;
      ctx.store.updateStatus(kbId, restore);
      emit(ctx, kbId, "committing", restore, filesTotal, filesDone, chunksDone);
      return {
        ok: false,
        cancelled: true,
        filesTotal,
        filesDone,
        chunkCount: firstRun ? 0 : kb.chunkCount,
        failedCount,
      };
    }
    // 真失败：首次建库计数归零可见失败；更新失败旧 counters 不动（旧索引保持可用）
    ctx.store.updateStatus(kbId, "error", firstRun ? { fileCount: 0, chunkCount: 0, failedCount: 0 } : undefined);
    emit(ctx, kbId, "committing", "error", filesTotal, filesDone, chunksDone);
    throw err;
  } finally {
    db.close();
  }
}
