// 后台增量索引：把 listUnindexed 的条目批量编码并写回。
//
// 设计要点：
// - 分批 + 每批之间让出事件循环，避免长时间占用 CPU 影响交互。
// - 单条失败只跳过该条（其 embedding 保持 NULL，下轮重试），不中断整批。
// - 可被并发调用：用 running 标记合并，重复调用直接返回同一 Promise。
// - 推理异常必须在本层兜住：本函数是后台调用，没有上层 catch，抛出去会变成
//   未捕获的 promise rejection；而失败通常是确定性的，重试同一批只会原地空转。
// - 本层只写 embedding 列，但**本轮真的写入过向量时**必须刷新一次量化索引
//   （见下面 finish() 的说明）——否则新写入的记忆在重启前永远搜不到。
import type { MemoryDao } from "./dao";
import { embedDocuments, embedFingerprint, isEmbedderReady } from "./embedder";
import { refreshQuantizedIndex } from "./vector-ext";

export interface IndexResult {
  indexed: number;
  failed: number;
  skipped: boolean;
}

let running: Promise<IndexResult> | null = null;

export interface IndexOptions {
  /** 每批编码条数（实测 batch=8 时约 4.8 ms/条） */
  batchSize?: number;
  /** 本轮最多处理多少条；缺省为全部待索引条目 */
  maxItems?: number;
}

/** 把待索引记忆编码落库。并发调用共享同一轮。 */
export async function indexPendingMemories(dao: MemoryDao, opts: IndexOptions = {}): Promise<IndexResult> {
  if (running) return running;
  running = runIndex(dao, opts).finally(() => {
    running = null;
  });
  return running;
}

async function runIndex(dao: MemoryDao, opts: IndexOptions): Promise<IndexResult> {
  const batchSize = opts.batchSize ?? 8;
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;
  const fingerprint = embedFingerprint();
  let indexed = 0;
  let failed = 0;

  /**
   * 本轮结束的统一出口：只要本轮真的写入了向量，就在返回前刷新一次量化索引。
   *
   * 为什么必须刷：`quantizedScan` 查的是扩展的量化 shadow table，而回填只写
   * `embedding` 列 —— 不刷则新写入的记忆在**重启前永远搜不到**（语义通道静默返回空，
   * 实测报 “Quantization table not found … Ensure that vector_quantize() has been called”）。
   * 为什么在这里刷而不是每次写入后刷：`vector_quantize` 是 O(N) 全量重建
   * （实测 10 万条约 1.6s + preload 0.1s），批量回填后一次是合理成本，
   * 逐条刷新会把后台任务变成持续 CPU 占用。
   */
  const finish = (done: number, bad: number, skipped: boolean): IndexResult => {
    if (done > 0) refreshQuantizedIndex(dao.db);
    return { indexed: done, failed: bad, skipped };
  };

  // 终止性：每轮要么 break，要么让 indexed + failed 至少 +1（逐条计数），
  // 因此即便模型不可用、编码结果为空数组也不会空转成死循环。
  while (indexed + failed < maxItems) {
    const pending = dao.listUnindexed(Math.min(batchSize, maxItems - indexed - failed));
    if (pending.length === 0) break;

    let vecs: Uint8Array[];
    try {
      vecs = await embedDocuments(pending.map((r) => `${r.title} ${r.content} ${r.tags}`));
    } catch (err) {
      // 推理期抛错（原生绑定异常等）：后台任务无上层捕获，必须在此兜住，
      // 绝不能让它变成未捕获的 promise rejection。结束本轮并返回已完成的计数。
      console.error("[memory-semantic] 批量编码失败，本轮索引提前结束：", err);
      return finish(indexed, failed, true);
    }
    if (vecs.length === 0) {
      // 模型不可用：本轮无法推进，直接结束（避免死循环）
      if (!isEmbedderReady()) return finish(indexed, failed, true);
      // 模型可用却整批编不出向量：待索引集合没有任何变化，若 continue 会一遍遍
      // 重取同一批、原地空转，故同样结束本轮（本轮终止，不留悬空循环）。
      failed += pending.length;
      break;
    }

    for (let i = 0; i < pending.length; i++) {
      const vec = vecs[i];
      if (!vec) {
        failed++;
        continue;
      }
      dao.setEmbedding(pending[i].id, vec, fingerprint);
      indexed++;
    }

    // 让出事件循环，避免回填期间把交互卡住
    await new Promise((r) => setTimeout(r, 0));
  }

  return finish(indexed, failed, false);
}
