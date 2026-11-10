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
//   - 更新失败：嵌入期失败时 chunks 表未动（旧索引保持可用）；commit 阶段整体单事务，
//     失败自动 ROLLBACK，旧数据零丢失；
//   - 更新取消：恢复原状态（ready），commit 事务未开始或整体回滚，旧数据原样保留。
// 量化索引刷新沿用 memory/vector-index.ts 的 finish 模式：本轮写过/删过向量才在收尾刷一次
// （vector_quantize 是 O(N) 全量重建，逐批刷新会把后台任务变成持续 CPU 占用）。
import type { Database } from "bun:sqlite";
import type { KbInfo } from "@wa-pi/shared";
import { bigram } from "../memory/bigram";
import { acquireEmbedderKeepAlive, embedDocuments, embedFingerprint } from "../memory/embedder";
import { scanFolder } from "./scan";
import { extractText } from "./extract";
import { chunkDocument, type KnowledgeChunk } from "./chunker";
import { openKbDb } from "./kb-db";
import { processOwnerId } from "./store";
import { refreshKbQuantizedIndex } from "./vector";
import type { KbContext } from "./index";

type KbPhase = NonNullable<KbInfo["progress"]>["phase"];
type KbStatus = KbInfo["status"];

// KbContext 定义在桶导出（任务 7/11 复用）；此处重导出让调用方从任一入口导入都可行
export type { KbContext } from "./index";

/** 单个失败文件（最近一轮索引的抽取阶段产生）；reason 为失败原因摘要 */
export interface KbFailure {
  path: string;
  reason: string;
}

/**
 * 失败文件清单（进程内内存：kbId → 最近一轮的失败文件及原因）。
 * 控制者裁决的最简方案：indexer 抽取失败处就地记录，route 直接读取。
 * kernel 重启后丢失可接受——登记行 failed_count 与 job.skip_stats 兑底展示数量。
 */
const kbFailures = new Map<string, KbFailure[]>();

/** 最近一轮索引的失败文件清单（无记录/库不存在返回空数组） */
export function getKbFailures(kbId: string): KbFailure[] {
  return kbFailures.get(kbId) ?? [];
}

/** 清除某库的失败清单（删库时调用，防 Map 无界增长） */
export function clearKbFailures(kbId: string): void {
  kbFailures.delete(kbId);
}

/** 嵌入与进度批大小（规格硬性：批 64，批间让出事件循环） */
export const INDEX_BATCH = 64;

/** 嵌入函数形状：缺省用真实 embedDocuments，测试注入 fake 绕开模型 */
export type EmbedFn = (texts: string[]) => Promise<Uint8Array[]>;

/**
 * 单个子批的嵌入条数：把一个 64 批的推理切成小块，块间让出事件循环。
 *
 * 为什么必须切：onnxruntime 推理在 kernel 主线程上连续占用（实测 533 字块的 64 条一批
 * 阻塞 28-33s，128 块整轮事件循环最大停顿 33s），SSE 心跳 5s 一次被饿死，超过前端
 * 10s 看门狗阈值 → 重建/新建到一半界面「连接已断开，正在重连」，进度也断在半路。
 * 子批 4 实测单次占用 1.3-2.2s（负载高时 ~6s）：心跳留足余量，吞吐与大批持平
 * （135 块 0.35s/块 vs 批 8 的 0.34s/块，固定开销占比小）。
 */
export const EMBED_YIELD_SUB_BATCH = 4;

/**
 * 把 embedFn 包成「子批推理 + 批间让出事件循环」：返回顺序与输入一一对应。
 * 让出窗口里跑 SSE 心跳、HTTP 路由与取消检查——长索引期间界面不断连、取消及时生效。
 */
export function wrapEmbedWithYield(
  embedFn: EmbedFn,
  subBatch: number = EMBED_YIELD_SUB_BATCH,
  signal?: AbortSignal,
): EmbedFn {
  return async (texts) => {
    if (texts.length <= subBatch) return embedFn(texts);
    const out: Uint8Array[] = [];
    for (let i = 0; i < texts.length; i += subBatch) {
      out.push(...(await embedFn(texts.slice(i, i + subBatch))));
      // 让出事件循环：心跳/HTTP/取消检查都在这个窗口里跑
      await new Promise((r) => setTimeout(r, 0));
      throwIfAborted(signal);
    }
    return out;
  };
}

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
  chunksTotal: number,
): void {
  try {
    ctx.sse({ type: "knowledge:progress", kbId, phase, status, filesTotal, filesDone, chunksDone, chunksTotal });
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
  // 重入防护：job 行是活动任务的唯一真源（startJob/finishJob 严格维护），
  // 存在即拒绝，防止 watcher/工具/路由多入口并发触发交错写同一 kb db。
  // 不用 status==="indexing" 判定：崩溃残骸（status 停在 indexing 但 job 行已不在）
  // 若也被拒会死锁无法重建；残留 status 会在下一轮成功后自然收敛。
  if (ctx.store.getJob(kbId)) {
    throw new Error(`知识库 ${kbId} 已有进行中的索引任务，拒绝重入`);
  }
  const prevStatus = kb.status;
  const firstRun = kb.lastIndexedAt === null;
  const fingerprint = embedFingerprint();
  // 库级指纹不匹配 = 存量向量全部过期（规格 §6.2）：视为未索引，快筛短路失效、hash 复用只留行不重嵌。
  // 指纹从登记库直读（KbInfo 投影不含 embed_meta）——从未索引过为 null，null 不算不匹配。
  const storedMeta = ctx.store.getEmbedMeta(kbId);
  const fingerprintMismatch = storedMeta !== null && storedMeta !== fingerprint;

  // owner 写入本进程标识：卡死兜底据此豁免本进程的活任务（进度长时间不刷新也不误杀）
  ctx.store.startJob(kbId, "scanning", { owner: processOwnerId() });
  ctx.store.updateStatus(kbId, "indexing");
  // 新起一轮：清空上一轮的失败清单（失败文件按 relPath 记录，抽取 catch 处写入）
  kbFailures.set(kbId, []);
  emit(ctx, kbId, "scanning", "indexing", kb.fileCount, 0, 0, 0);

  let filesTotal = 0;
  let filesDone = 0;
  let failedCount = 0;
  let chunksDone = 0;
  // 本轮待嵌入块总量（embedding 阶段才可知，之前保持 0——前端据此把进度条从文件阶段切到块阶段）
  let chunksTotal = 0;

  // db 可空：openKbDb（每库文件损坏/不可写时抛 SQLITE_NOTADB 等）必须在主体 try 内——
  // 否则 startJob 之后裸抛会残留 job 行 + status 卡 indexing，且 cancel/delete/index
  // 三条恢复路径全灭、重启不恢复（审查修复回归：knowledge-routes 测试第 9 条锁定）。
  // catch 对 db 做空值防护：未打开时跳过首建清理。
  let db: Database | null = null;
  // 嵌入按子批跑并在批间让出（见 wrapEmbedWithYield）：不把主线程一次占住几十秒
  const embed = wrapEmbedWithYield(embedFn, EMBED_YIELD_SUB_BATCH, signal);
  // 索引全程持有 embedder 保活引用：抽取阶段可能长时间不调嵌入，若放任空闲卸载，
  // 嵌入阶段要重新加载模型（用户可见为「建库到一半模型被释放」）。
  const releaseKeepAlive = acquireEmbedderKeepAlive();
  try {
    // ===== 阶段 0：打开每库 db =====
    db = openKbDb(ctx.waPiDir, kbId);
    // ===== 阶段 1：扫描（先数不写，复用任务 3）=====
    throwIfAborted(signal);
    // excludePaths（扫描第 1 层）未接线：产品层无排除入口，此处省略 = 不过滤
    const preview = await scanFolder(kb.folderPath);
    filesTotal = preview.indexable.length;
    const skipStats: Record<string, number> = {};
    for (const s of preview.skips) skipStats[s.reason] = (skipStats[s.reason] ?? 0) + 1;
    ctx.store.updateJobProgress(kbId, { filesTotal, skipStats });
    emit(ctx, kbId, "scanning", "indexing", filesTotal, 0, 0, 0);

    const existing = loadExisting(db);

    // 归零突变保护：目录「可读但为空」而库里已有索引——网络盘/外置卷瞬时挂空的典型形态。
    // 不拦的话「未认领即删除」会把全部存量块删光，并作为一次成功的索引置 ready（内容归零、
    // 无法回滚）。首建且本来为空（库里没有任何行）不受影响，照常置 ready 的空库。
    if (filesTotal === 0 && existing.byPath.size > 0) {
      throw new Error(
        `扫描结果为空但库内已有 ${existing.byPath.size} 个文件的索引（目录可能瞬时不可读/未挂载），已拒绝本轮以免清空库`,
      );
    }

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
      } catch (err) {
        // 单文件失败不拖垮整轮（规格 §6.3）；extraction_failed 由抽取阶段产生，计入跳过统计；
        // 失败文件及原因就地记入内存清单（GET /api/knowledge/:id/failed 读取，任务 10）
        failedCount++;
        kbFailures.get(kbId)?.push({
          path: file.relPath,
          reason: err instanceof Error ? err.message : String(err),
        });
        skipStats.extraction_failed = (skipStats.extraction_failed ?? 0) + 1;
        filesDone++;
        ctx.store.updateJobProgress(kbId, { phase: "extracting", filesDone, skipStats: { ...skipStats } });
        emit(ctx, kbId, "extracting", "indexing", filesTotal, filesDone, 0, 0);
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
      emit(ctx, kbId, "extracting", "indexing", filesTotal, filesDone, 0, 0);
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
    chunksTotal = needEmbed.length;
    ctx.store.updateJobProgress(kbId, { phase: "embedding", chunksTotal });
    emit(ctx, kbId, "embedding", "indexing", filesTotal, filesDone, 0, chunksTotal);
    for (let i = 0; i < needEmbed.length; i += INDEX_BATCH) {
      throwIfAborted(signal);
      const batch = needEmbed.slice(i, i + INDEX_BATCH);
      const vecs = await embed(batch.map((b) => b.prefixContent));
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
      emit(ctx, kbId, "embedding", "indexing", filesTotal, filesDone, chunksDone, chunksTotal);
      // 让出事件循环（桌面 UI 不卡；规格 §6.3 硬性要求）
      await new Promise((r) => setTimeout(r, 0));
    }

    // ===== 阶段 5：落库（单个大事务：FTS 应用层同事务双写，不用触发器——规格 §6.1）=====
    // 整个 commit 阶段（变化文件重写 + 已删文件移除 + 回填 UPDATE）包进同一事务：
    // 失败/异常时 SQLite 自动 ROLLBACK，旧块零丢失——「更新失败旧数据不动」在数据层逐字成立。
    throwIfAborted(signal);
    ctx.store.updateJobProgress(kbId, { phase: "committing" });
    emit(ctx, kbId, "committing", "indexing", filesTotal, filesDone, chunksDone, chunksTotal);
    const nowPaths = new Set(preview.indexable.map((f) => f.relPath));
    const removedPaths: string[] = [];
    for (const [path] of existing.byPath) if (!nowPaths.has(path)) removedPaths.push(path);

    // 事务闭包内不可引用可变外层变量（TS 无法窄化）：捕获此刻已打开的连接为不可变别名
    const kdb = db as Database;
    // 本事务是否删/插过行：行重建会让 rowid 变化，量化 shadow（按 rowid JOIN）必须随之重建，
    // 即便本轮 needEmbed/removedPaths 都为 0（touch 类「mtime 变、内容不变、hash 全复用」）
    let touchedRows = false;
    const commitAll = kdb.transaction(() => {
      const deleteFileRows = (relPath: string) => {
        // 先删 FTS（子查询依赖 chunks 行）再删块
        kdb.run(`DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)`, [relPath]);
        kdb.run(`DELETE FROM chunks WHERE file_path = ?`, [relPath]);
      };
      const now = Date.now();
      for (const plan of plans) {
        if (plan.hasOld) {
          deleteFileRows(plan.relPath);
          touchedRows = true;
        }
        for (let i = 0; i < plan.chunks.length; i++) {
          const c = plan.chunks[i];
          const reuse = plan.reuse.get(i);
          const id = reuse?.id ?? c.id;
          const embedding = reuse?.embedding ?? vecByChunk.get(c) ?? null;
          kdb.run(
            `INSERT INTO chunks (id, file_path, file_type, title, breadcrumb, start_line, end_line,
               content, prefix_content, content_hash, file_mtime, file_size, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id, c.relPath, c.fileType, c.title ?? null, c.breadcrumb ?? null,
              c.startLine, c.endLine, c.content, c.prefixContent, c.contentHash,
              plan.mtime, plan.size, embedding, now,
            ],
          );
          kdb.run(`INSERT INTO chunks_fts (body, chunk_id) VALUES (?, ?)`, [bigram(c.prefixContent), id]);
        }
      }
      for (const relPath of removedPaths) deleteFileRows(relPath);
      for (const b of needEmbed) {
        if (b.backfillId !== undefined) {
          // 嵌入批完成后 vec 必已就位
          kdb.run(`UPDATE chunks SET embedding = ? WHERE id = ?`, [b.vec as Uint8Array, b.backfillId]);
        }
      }
    });
    commitAll();

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
    ctx.store.setLastError(kbId, null); // 成功一轮后清空历史失败原因
    emit(ctx, kbId, "committing", "ready", filesTotal, filesDone, chunksDone, chunksTotal);
    // 本轮写过/删过向量，或行被删除重建（rowid 变了）才刷量化索引
    // （O(N) 全量重建，沿用 memory finish 模式；只看 needEmbed/removed 会漏掉 touch 类重建）
    if (touchedRows || needEmbed.length > 0 || removedPaths.length > 0) refreshKbQuantizedIndex(db);

    return { ok: true, cancelled: false, filesTotal, filesDone, chunkCount: chunkTotal, failedCount };
  } catch (err) {
    const cancelled = signal?.aborted === true;
    // 先清 job 行（幂等 DELETE）：它必须先于下面任何一步——连接被外部 evict 时回滚写库必抛，
    // job 行残留则重入防护永远挡回，而任务 1 的 owner 存活判定又会豁免本进程 → 永不回收
    ctx.store.finishJob(kbId);
    if (firstRun && db) {
      // 首次建库（取消或失败）：删该库全部块，不留半成品（db 未打开则无块可清）。
      // 连接可能已被外部关闭（evict/删库）：残块随库文件一起消失，清不掉不是新问题——只告警，不阻断收尾
      try {
        db.run(`DELETE FROM chunks_fts`);
        db.run(`DELETE FROM chunks`);
        refreshKbQuantizedIndex(db);
      } catch (cleanupErr) {
        console.warn(
          `[knowledge] 首建失败后的残块清理跳过（连接已被外部 evict）: kbId=${kbId}`,
          cleanupErr,
        );
      }
    }
    if (cancelled) {
      // 取消：恢复原状态（新建库 prevStatus=scanning；同库单 job 下 prevStatus 不会是 indexing）
      const restore: KbStatus = prevStatus === "indexing" ? "scanning" : prevStatus;
      ctx.store.updateStatus(kbId, restore);
      emit(ctx, kbId, "committing", restore, filesTotal, filesDone, chunksDone, chunksTotal);
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
    // 失败原因上界面（此前只进 console.warn，用户只看到「索引中断」）
    ctx.store.setLastError(kbId, err instanceof Error ? err.message : String(err));
    emit(ctx, kbId, "committing", "error", filesTotal, filesDone, chunksDone, chunksTotal);
    throw err;
  } finally {
    releaseKeepAlive();
    // 不关闭每库 db：连接归 kb-db 缓存所有（同库的检索可能正命中同一实例，关掉会打断它）。
    // 释放时机：删库时 evictKbDb、进程退出时 closeAllKbDbs
  }
}
