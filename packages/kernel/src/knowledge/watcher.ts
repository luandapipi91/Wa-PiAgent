// 知识库文件监听（任务 11，规格 §6.7「自动更新」）：
//   - fs.watch(folder, { recursive: true })（Windows 原生支持）是加速器；
//   - setInterval(60s) 快照轮询是正确性兜底（监听失效/网络盘场景），复用 scanFolder
//     与索引完全一致的过滤逻辑（excludePaths 同传 []），保证监听范围=索引范围不漂移；
//   - 两套机制共用一个防抖槽（2s）：git checkout 式批量变更只触发一轮 update；
//   - 合并语义：同库 runIndex 进行中再触发 → dirty 标记，本轮完成后自动重跑一次（排队合并，不重复开）。//   - 重入协调（审查修复）：手动更新（ws-server 同一 runIndex）进行中时触发不丢弃，防抖重排//     等待手动完成后自动补跑——变更最多延迟、不丢失；轮询基线仅在索引成功后推进。
// 监听是库级开关（autoWatch，列表页「自动更新」默认开）：关掉后仅手动更新/重建。
// 中断恢复（规格 §6.7）：restoreWatchers 对 status=indexing 的库置 error（不自动续跑）；
// 卡死兜底：轮询发现 isJobStuck(kbId)（默认调用形式——at 取 job.lastProgressAt 假想进度时刻，
// 见 store.isJobStuck 注释）→ 清残留 job 行后走防抖槽重索引。
import { watch, type FSWatcher } from "node:fs";
import { runIndex, type EmbedFn, type IndexResult } from "./indexer";
import { scanFolder } from "./scan";
import type { KbContext } from "./index";

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_DEBOUNCE_MS = 2_000;

/** 索引执行器形状：缺省 runIndex（带 embedFn），测试注入 spy/计数 */
export type IndexFn = (
  ctx: KbContext,
  kbId: string,
  signal?: AbortSignal,
) => Promise<IndexResult>;

export interface WatchKbOptions {
  /** 兜底轮询间隔（默认 60_000；测试注入加速） */
  pollIntervalMs?: number;
  /** 防抖窗口（默认 2_000；测试注入加速） */
  debounceMs?: number;
  /** 索引执行器（缺省 runIndex；测试注入 spy） */
  indexFn?: IndexFn;
  /** 嵌入函数（透传缺省 runIndex；测试注入 fake 绕开模型） */
  embedFn?: EmbedFn;
  /** 外部取消信号（aborted 时自动 stop，watcher 内部的索引用内部 signal 中止） */
  signal?: AbortSignal;
}

/** watchKb 返回的控制器：stop 清 watcher + 轮询 interval + 防抖定时器并中止进行中索引 */
export interface KbWatchController {
  stop(): void;
  /** fs.watch 句柄（测试/诊断用它 close() 模拟监听失效，验证 60s 轮询兜底） */
  readonly fsWatcher: FSWatcher | null;
}

/**
 * 给单个库挂自动维护（fs.watch 加速 + 60s 轮询兜底 + 防抖 + 合并）。
 * 调用方保证库存在；folder 不存在/监听失败时轮询照常兜底（目录可读后自愈）。
 */
export function watchKb(ctx: KbContext, kbId: string, opts: WatchKbOptions = {}): KbWatchController {
  const kb = ctx.store.getKb(kbId);
  if (!kb) throw new Error(`知识库不存在：${kbId}`);
  const folder = kb.folderPath; // 闭包用（TS 窄化不跨嵌套函数）
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const indexFn: IndexFn =
    opts.indexFn ?? ((c, id, signal) => runIndex(c, id, opts.embedFn, signal));

  let stopped = false;
  let running = false; // 本 watcher 触发的一轮 runIndex 进行中
  let dirty = false; // 进行中又有变更触发 → 本轮完成后重跑一次
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fsWatcher: FSWatcher | null = null;
  let lastSnapshot: string | null = null; // relPath+mtime+size 联合键（scanFolder 已排序；null=基线未就绪）
  let pendingReport = false; // 有未消化的变更已排队（schedule 置位、索引消化后复位）——轮询同一差异只上报一次，
  // 否则基线不推进的轮询会每个周期重复 schedule 重置防抖窗口，timer 永不到期（触发饥饿）
  const internalAbort = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) return { stop, get fsWatcher() {
      return fsWatcher;
    } }; // 已取消：不挂任何监听（stop 可重复调用）
    opts.signal.addEventListener("abort", () => stop(), { once: true });
  }

  /**
   * 目录快照：复用 scanFolder 过滤逻辑（excludePaths 与 runIndex 同传 []），
   * 只取可索引清单的 relPath+mtime+size——与增量快筛判定同源，监听范围=索引范围。
   */
  async function takeSnapshot(): Promise<string> {
    const preview = await scanFolder(folder, []);
    return preview.indexable.map((f) => `${f.relPath}|${f.mtime}|${f.size}`).join("\n");
  }

  /** 触发一轮索引；进行中则只标 dirty，本轮完成后 do-while 重跑一次吸收变更 */
  async function trigger(): Promise<void> {
    if (running) {
      dirty = true;
      return;
    }
    // 前置重入检查：手动更新（ws-server 走同一 runIndex，重入防护基于 job 行）进行中时
    // 不开新轮，防抖重排等待它完成——否则每轮 trigger 撞 indexer 重入拒绝抛错，
    // 既吞触发意图（dirty 已消费）又 2s 一条 warn 刷屏
    if (ctx.store.getJob(kbId)) {
      schedule();
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        await indexFn(ctx, kbId, internalAbort.signal);
      } while (dirty && !stopped);
      // 成功后才推进基线（变更未被索引消化前，轮询的差异信号必须保持）：
      // 拍当前目录快照——含本轮进行中窗口内被 runIndex 消化的变更；
      // 「落库后、快照前」毫秒级写入的极端竞态留待下次变更/轮询触发全量快筛消化，不会永久丢失
      if (!stopped) {
        lastSnapshot = await takeSnapshot();
        pendingReport = false; // 变更已消化：轮询可恢复上报新差异
      }
    } catch (err) {
      // job 行仍在 = 触发遭重入拒绝（TOCTOU 窗口：前置检查后手动任务才起跑）——
      // 保留触发意图防抖重排；job 行已清 = 真失败/取消（runIndex 收尾已删行，且已落库
      // status=error 并经 ctx.sse 广播），不重排防失败循环，交由下次变更/轮询再触发
      if (!stopped && ctx.store.getJob(kbId)) {
        schedule(); // pendingReport 由 schedule 保持置位（变更仍未消化）
      } else {
        pendingReport = false; // 真失败/取消：不再自动重排防失败循环；下轮轮询差异会再报（自愈重试）
        console.warn(`[knowledge] 自动索引失败 (kbId=${kbId}):`, err);
      }
    } finally {
      running = false;
    }
  }

  /** 防抖槽：窗口内重复触发只保留最后一次（fs.watch 与轮询共享）；置位 pendingReport 让轮询不再重复上报 */
  function schedule(): void {
    if (stopped) return;
    pendingReport = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void trigger();
    }, debounceMs);
  }

  // fs.watch 加速器：递归监听（Windows 原生支持）；事件回调不区分事件类型——
  // 变更细节交给 runIndex 增量快筛判定。监听失效（error）由轮询兜底，静默不中断。
  try {
    fsWatcher = watch(folder, { recursive: true }, () => schedule());
    fsWatcher.on("error", (err) => {
      console.warn(`[knowledge] fs.watch 监听失效，60s 轮询兜底 (kbId=${kbId}):`, err);
    });
  } catch (err) {
    console.warn(`[knowledge] fs.watch 挂载失败，仅轮询兜底 (kbId=${kbId}):`, err);
    fsWatcher = null;
  }

  // 挂载即拍基线快照（异步；基线未就绪前轮询只建基线不判变更，防止误触发）
  void takeSnapshot()
    .then((s) => {
      if (!stopped) lastSnapshot = s;
    })
    .catch(() => {}); // 目录暂不可读：下轮轮询再建基线

  // 60s 兜底轮询：快照有差异 → 防抖槽触发（基线不在此推进——变更未被索引消化前差异信号
  // 必须保持，否则 trigger 遭重入拒绝后轮询永远不再兜回）；无差异但 job 卡死（默认调用形式
  // isJobStuck(kbId)，10 分钟无进度更新）→ 清残留 job 行后同样走防抖槽重索引
  //（runIndex 重入防护基于 job 行存在）。
  pollTimer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      let snap: string;
      try {
        snap = await takeSnapshot();
      } catch {
        return; // 目录暂不可读：下轮再试
      }
      if (stopped) return;
      if (lastSnapshot !== null && snap !== lastSnapshot) {
        if (!pendingReport) schedule(); // 同一差异只上报一次（见 pendingReport 声明处注释）
        return; // 基线推进权在 trigger 成功路径（见 trigger 内注释）
      }
      lastSnapshot = snap; // 无差异：快照与基线一致，刷新无害（含首轮建基线）
      if (ctx.store.isJobStuck(kbId)) {
        ctx.store.finishJob(kbId); // 清卡死残骸 job（否则 runIndex 拒绝重入）
        schedule();
      }
    })();
  }, pollMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pollTimer) clearInterval(pollTimer);
    try {
      fsWatcher?.close();
    } catch {
      /* 已失效/已关闭：目标状态即无监听 */
    }
    fsWatcher = null;
    internalAbort.abort(); // 中止进行中索引（runIndex 取消语义：恢复原状态，旧索引保留）
  }

  return { stop, get fsWatcher() {
    return fsWatcher;
  } };
}

/** restoreWatchers 返回的控制器：kernel 退出时统一清掉全部 watcher */
export interface RestoreWatchersController {
  stopAll(): void;
}

/**
 * 启动恢复（规格 §6.7）：对所有库做中断恢复 + 按 autoWatch 重挂监听。
 *   - status=indexing（上次中断残骸）：置 error，不自动续跑；残留 job 行一并清掉
 *     （runIndex 重入防护基于 job 行存在，不清则该库永远无法再索引）；
 *   - autoWatch=1 且 status=ready：挂监听；
 *   - 其余（scanning/error/autoWatch 关）不挂——关掉后仅手动更新/重建。
 */
export function restoreWatchers(ctx: KbContext, opts: WatchKbOptions = {}): RestoreWatchersController {
  const controllers: KbWatchController[] = [];
  for (const kb of ctx.store.listKbs()) {
    try {
      if (kb.status === "indexing") {
        ctx.store.finishJob(kb.id);
        ctx.store.updateStatus(kb.id, "error");
        continue;
      }
      if (kb.autoWatch && kb.status === "ready") {
        controllers.push(watchKb(ctx, kb.id, opts));
      }
    } catch (err) {
      // 单库恢复失败不拖垮其余库（如库行元数据异常）
      console.warn(`[knowledge] 启动监听恢复失败 (kbId=${kb.id}):`, err);
    }
  }
  return {
    stopAll: () => {
      for (const c of controllers) c.stop();
      controllers.length = 0;
    },
  };
}
