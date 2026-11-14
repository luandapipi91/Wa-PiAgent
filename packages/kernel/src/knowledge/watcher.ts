// 知识库文件监听（任务 11，规格 §6.7「自动更新」）：
//   - fs.watch(folder, { recursive: true })（Windows 原生支持）是加速器；
//   - setInterval(60s) 快照轮询是正确性兜底（监听失效/网络盘场景），复用 scanFolderAsync
//     与索引完全一致的过滤逻辑（excludePaths 未接线，与 runIndex 一样省略），保证监听范围=索引范围不漂移；
//   - 两套机制共用一个防抖槽（2s）：git checkout 式批量变更只触发一轮 update；
//   - 轮询快照单飞：单轮扫描可能超过轮询间隔（网络盘大目录），已在跑则跳过本轮，不叠罗汉；
//   - 合并语义：同库 runIndex 进行中再触发 → dirty 标记，本轮完成后自动重跑一次（排队合并，不重复开）。//   - 重入协调（审查修复）：手动更新（ws-server 同一 runIndex）进行中时触发不丢弃，防抖重排//     等待手动完成后自动补跑——变更最多延迟、不丢失；轮询基线仅在索引成功后推进。
// 监听是库级开关（autoWatch，列表页「自动更新」默认开）：关掉后仅手动更新/重建。
// 中断恢复（规格 §6.7）：restoreWatchers 对 status=indexing 的库置 error（不自动续跑）；
// 卡死兜底：轮询发现 isJobStuck(kbId)（owner 存活则恒为 false；owner 失联且心跳超 10 分钟
// 才判卡死，见 store.isJobStuck 注释）→ 清残留 job 行后走防抖槽重索引。
import { watch, type FSWatcher } from "node:fs";
import { runIndex, type EmbedFn, type IndexResult } from "./indexer";
import { scanFolderAsync } from "./scan";
import { RESOURCE_DIR_NAME } from "./mirror";
import type { KbContext } from "./index";

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_DEBOUNCE_MS = 2_000;

/** 索引执行器形状：缺省 runIndex（带 embedFn），测试注入 spy/计数 */
export type IndexFn = (
  ctx: KbContext,
  kbId: string,
  signal?: AbortSignal,
) => Promise<IndexResult>;

/**
 * 轮询基线推进判定：只有「成功」才允许推进。
 * runIndex 取消是正常 resolve（ok:false, cancelled:true）而非抛错——若不看 ok 就推进，
 * 这批变更会被标记成已消化，轮询再也无法发现差异（变更静默丢失直到下次文件变动）。
 */
export function shouldAdvanceBaseline(r: Pick<IndexResult, "ok" | "cancelled">): boolean {
  return r.ok === true;
}

export interface WatchKbOptions {
  /** 兜底轮询间隔（默认 60_000；测试注入加速） */
  pollIntervalMs?: number;
  /** 防抖窗口（默认 2_000；测试注入加速） */
  debounceMs?: number;
  /** 索引执行器（缺省 runIndex；测试注入 spy） */
  indexFn?: IndexFn;
  /** 嵌入函数（透传缺省 runIndex；测试注入 fake 绕开模型） */
  embedFn?: EmbedFn;
  /** 目录快照获取器（缺省 takeSnapshot；仅测试注入，用来挂住一轮快照验证单飞守卫） */
  snapshotFn?: () => Promise<string>;
  /** 外部取消信号（aborted 时自动 stop，watcher 内部的索引用内部 signal 中止） */
  signal?: AbortSignal;
}

/** watchKb 返回的控制器：stop 清 watcher + 轮询 interval + 防抖定时器并中止进行中索引 */
export interface KbWatchController {
  stop(): void;
  /** 仅中止当前进行中的自动索引（不动监听/轮询/防抖，watcher 继续存活）——cancel 端点对 watcher 源索引用 */
  cancelIndex(): void;
  /** 有一轮自动索引进行中（cancel 端点判断「是否有可取消的任务」用） */
  readonly indexing: boolean;
  /** fs.watch 句柄（测试/诊断用它 close() 模拟监听失效，验证 60s 轮询兜底） */
  readonly fsWatcher: FSWatcher | null;
  /** 已停止（测试断言 delete/stopAll 后监听与轮询已关） */
  readonly stopped: boolean;
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
  // relPath+mtime+size 联合键（快照已排序；null=基线未就绪）。
  // 基线持久化（§6 决策 9）：初值续接上次成功索引时持久化的快照——软件关闭期间的源变更
  // 不被重拍吞掉，重启后首轮轮询 diff 即发现差异并自动补偿索引；无持久化基线（null）
  // 维持现状拍新基线，不误触发。
  let lastSnapshot: string | null = ctx.store.getLastSnapshot(kbId);
  let suppressedSnapshot: string | null = null; // 取消那一刻的目录快照：同批变更不再自动触发（尊重用户取消），
  // 出现新变更（快照变化）后照常触发——此时基线仍是旧值，全量快筛会把遗留变更一并消化
  let pendingReport = false; // 有未消化的变更已排队（schedule 置位、索引消化后复位）——轮询同一差异只上报一次，
  // 否则基线不推进的轮询会每个周期重复 schedule 重置防抖窗口，timer 永不到期（触发饥饿）
  let currentAbort: AbortController | null = null; // 当前进行中那轮索引的控制器（每轮新建，索引间隙为 null）
  let snapshotInFlight = false; // 快照单飞：同一时刻只允许一个扫描在跑（见 guardedSnapshot）
  if (opts.signal) {
    if (opts.signal.aborted)
      return {
        stop,
        cancelIndex,
        get indexing() {
          return running;
        },
        get fsWatcher() {
          return fsWatcher;
        },
        get stopped() {
          return stopped;
        },
      }; // 已取消：不挂任何监听（stop 可重复调用）
    opts.signal.addEventListener("abort", () => stop(), { once: true });
  }

  /**
   * 目录快照：复用 scanFolderAsync 过滤逻辑（excludePaths 未接线，与 runIndex 一致省略），
   * 只取可索引清单的 relPath+mtime+size——与增量快筛判定同源，监听范围=索引范围。
   * 走异步版：轮询每 60s 一次，大目录同步扫描会阻塞事件循环影响 WS 心跳/其他库索引。
   */
  async function takeSnapshot(): Promise<string> {
    const preview = await scanFolderAsync(folder);
    return preview.indexable.map((f) => `${f.relPath}|${f.mtime}|${f.size}`).join("\n");
  }

  const snapshotFn = opts.snapshotFn ?? takeSnapshot;

  /**
   * 快照单飞守卫：同一时刻最多一个扫描在跑，已在跑则返回 null（调用方跳过本轮，下个间隔重试）。
   * 为什么需要：扫描异步化后单轮可能超过 pollIntervalMs（网络盘 10 万文件可达分钟级），固定节拍的
   * setInterval 会按时起新的一轮叠罗汉；且慢的旧快照晚到会覆盖 lastSnapshot、制造虚假差异。
   * 为什么选「单飞开关」而非自调度 setTimeout：固定节拍不变（自调度会把间隔变成「扫描耗时 + pollMs」，
   * 慢盘下检测频率持续漂移）；stop() 仍是幂等清 timer，不依赖任何在飞状态。
   * 挂载基线也走同一守卫：首轮扫描同样可能超过一个轮询周期，基线晚到覆盖新值也是虚假差异。
   */
  async function guardedSnapshot(): Promise<string | null> {
    if (snapshotInFlight) return null;
    snapshotInFlight = true;
    try {
      return await snapshotFn();
    } finally {
      snapshotInFlight = false; // 无论成功/失败/拒绝都要归还，否则轮询永久停摆
    }
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
      let allOk = true;
      do {
        dirty = false;
        // 每轮独立控制器：cancelIndex 只中止当前轮，watcher（监听/轮询）继续存活接后续触发
        const abort = new AbortController();
        currentAbort = abort;
        try {
          const r = await indexFn(ctx, kbId, abort.signal);
          allOk = allOk && shouldAdvanceBaseline(r);
        } finally {
          if (currentAbort === abort) currentAbort = null;
        }
      } while (dirty && !stopped);
      // 成功后才推进基线（变更未被索引消化前，轮询的差异信号必须保持）：
      // 拍当前目录快照——含本轮进行中窗口内被 runIndex 消化的变更；
      // 「落库后、快照前」毫秒级写入的极端竞态留待下次变更/轮询触发全量快筛消化，不会永久丢失
      if (!stopped) {
        if (allOk) {
          lastSnapshot = await takeSnapshot();
          // 基线同步持久化（§6 决策 9）：下次挂载续接，离线变更可补偿；取消/失败分支不持久化
          // （差异信号保留语义不变——变更未被消化前，轮询的差异信号必须保持）
          ctx.store.setLastSnapshot(kbId, lastSnapshot);
          suppressedSnapshot = null;
          pendingReport = false; // 变更已消化：轮询可恢复上报新差异
        } else {
          // 取消（或未成功）：基线不推进（差异信号保留），但记下当前快照抑制同批重试——
          // 用户主动取消后不应被下一轮轮询立刻推翻；出现新变更时快照与 suppressed 不同，
          // 轮询照常触发，那轮全量快筛会把遗留变更一并消化
          suppressedSnapshot = await takeSnapshot();
          pendingReport = false;
        }
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
    fsWatcher = watch(folder, { recursive: true }, (_event, changedPath) => {
      // 「知识库资源」目录（markdown 副本）的事件忽略：副本是派生中间产物，
      // 它的写入不该被当成源变更（否则每次索引写副本都会多触发一轮空转索引）。
      // filename 为 null（部分平台/事件）时保守放行走既有防抖+快照对比链路。
      if (
        typeof changedPath === "string" &&
        changedPath.split(/[\\/]/)[0] === RESOURCE_DIR_NAME
      )
        return;
      schedule();
    });
    fsWatcher.on("error", (err) => {
      console.warn(`[knowledge] fs.watch 监听失效，60s 轮询兜底 (kbId=${kbId}):`, err);
    });
  } catch (err) {
    console.warn(`[knowledge] fs.watch 挂载失败，仅轮询兜底 (kbId=${kbId}):`, err);
    fsWatcher = null;
  }

  // 挂载即拍基线快照（异步；基线未就绪前轮询只建基线不判变更，防止误触发）。
  // 持久化基线已续接（lastSnapshot 非空）则不重拍——重拍会把离线变更吞进基线、永不补偿（§6 决策 9）
  if (lastSnapshot === null) {
    void guardedSnapshot()
      .then((s) => {
        if (!stopped && s !== null && lastSnapshot === null) lastSnapshot = s;
      })
      .catch(() => {}); // 目录暂不可读：下轮轮询再建基线
  }

  // 60s 兜底轮询：快照有差异 → 防抖槽触发（基线不在此推进——变更未被索引消化前差异信号
  // 必须保持，否则 trigger 遭重入拒绝后轮询永远不再兜回）；无差异但 job 卡死
  // （默认调用形式 isJobStuck(kbId)：owner 存活时恒为 false，失联且心跳超 10 分钟才为 true）
  // → 清残留 job 行后同样走防抖槽重索引（runIndex 重入防护基于 job 行存在）。
  pollTimer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      let snap: string | null;
      try {
        snap = await guardedSnapshot();
      } catch {
        return; // 目录暂不可读：下轮再试
      }
      if (snap === null) return; // 单飞：上一轮仍在跑，跳过本轮（下个间隔自然重试）
      if (stopped) return;
      if (lastSnapshot !== null && snap !== lastSnapshot) {
        // 与取消时刻完全相同的差异不再上报（尊重取消）；slow 变化会改变快照 → 恢复触发
        if (snap !== suppressedSnapshot && !pendingReport) schedule();
        return; // 基线推进权在 trigger 成功路径（见 trigger 内注释）
      }
      lastSnapshot = snap; // 无差异：快照与基线一致，刷新无害（含首轮建基线）
      if (ctx.store.isJobStuck(kbId)) {
        ctx.store.finishJob(kbId); // 清卡死残骸 job（否则 runIndex 拒绝重入）
        schedule();
      }
    })();
  }, pollMs);

  /** 仅中止当前进行中的索引；不动 stopped/timer/watcher——后续变更/轮询照常触发新轮 */
  function cancelIndex(): void {
    currentAbort?.abort(); // runIndex 取消语义：恢复原状态、删 job 行；trigger catch 判定后不重排
  }

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
    currentAbort?.abort(); // 中止进行中索引（runIndex 取消语义：恢复原状态，旧索引保留）
  }

  return {
    stop,
    cancelIndex,
    get indexing() {
      return running;
    },
    get fsWatcher() {
      return fsWatcher;
    },
    get stopped() {
      return stopped;
    },
  };
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
export function restoreWatchers(
  ctx: KbContext,
  opts: WatchKbOptions = {},
  hooks: { onAttach?: (kbId: string, controller: KbWatchController) => void } = {},
): RestoreWatchersController {
  const controllers: KbWatchController[] = [];
  for (const kb of ctx.store.listKbs()) {
    try {
      if (kb.status === "indexing") {
        ctx.store.finishJob(kb.id);
        ctx.store.updateStatus(kb.id, "error");
        continue;
      }
      if (kb.autoWatch && kb.status === "ready") {
        const controller = watchKb(ctx, kb.id, opts);
        controllers.push(controller);
        // 恢复挂上的 watcher 同步进调用方的运行登记（最终审查修复：否则 delete 时
        // 拆不到它，留下孤儿 watcher 60s 轮询+反复 warn 直到重启）
        hooks.onAttach?.(kb.id, controller);
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
