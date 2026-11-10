import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore, resetJobOwnerStateForTest } from "../src/knowledge/store";
import { runIndex, type KbContext, type EmbedFn, type IndexResult } from "../src/knowledge/indexer";
import { watchKb, restoreWatchers, shouldAdvanceBaseline, type WatchKbOptions } from "../src/knowledge/watcher";
import { closeAllKbDbs, openKbDb } from "../src/knowledge/kb-db";
import { EMBED_DIM } from "../src/memory/schema";

// 知识库文件监听测试（任务 11，规格 §6.7）：真实临时目录 + 真实 fs.watch，
// waitFor 用轮询断言（带超时）。加速注入 pollIntervalMs/debounceMs（默认 60_000/2_000）。
// runIndex spy 走 indexFn 注入（bun 1.4 mock.module 无恢复 API，见 scripts/test.ts，不用它）。

const fakeEmbed: EmbedFn = async (texts) => texts.map(() => new Uint8Array(EMBED_DIM).fill(128));

let waPiDir: string;
let srcDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;
let kbId: string;

beforeEach(() => {
  waPiDir = mkdtempSync(join(tmpdir(), "kb-watch-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-watch-src-"));
  writeFileSync(join(srcDir, "a.md"), "# A1\n\n内容甲第一段。\n\n# A2\n\n内容乙第二段。");
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  ctx = { store, waPiDir, sse: () => {} };
  kbId = store.createKb({ folderPath: srcDir }).id;
});

afterEach(() => {
  closeAllKbDbs(); // 每库连接归缓存所有，用例间必须归位
  resetJobOwnerStateForTest(); // 存活 owner 表是模块级状态，用例间必须归位
  reg.close();
  rmSync(waPiDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 夹具先跑一轮初始索引（fake embed），返回初始块数 */
async function initialIndex(): Promise<number> {
  await runIndex(ctx, kbId, fakeEmbed);
  return store.getKb(kbId)!.chunkCount;
}

/** 计数 spy：真实 runIndex 包一层（测试断言触发次数） */
function spyIndexFn(): { calls: () => number; fn: NonNullable<WatchKbOptions["indexFn"]> } {
  let n = 0;
  return {
    calls: () => n,
    fn: async (c, id, signal) => {
      n++;
      return runIndex(c, id, fakeEmbed, signal) as Promise<IndexResult>;
    },
  };
}

async function writeMd(name: string, content: string): Promise<void> {
  await Bun.write(join(srcDir, name), content);
}

test("watchKb：源目录新增 md 文件后触发 update 并索引到新内容", async () => {
  const initialCount = await initialIndex();
  expect(initialCount).toBeGreaterThan(0);
  const w = watchKb(ctx, kbId, { embedFn: fakeEmbed });
  await writeMd("new.md", "# 新章节\n内容");
  await waitFor(() => store.getKb(kbId)!.chunkCount > initialCount, 15_000);
  w.stop();
});

test("2 秒防抖：窗口内多次写文件只触发一次 update", async () => {
  await initialIndex();
  const spy = spyIndexFn();
  const w = watchKb(ctx, kbId, { embedFn: fakeEmbed, indexFn: spy.fn });
  // 100ms 间隔连写 3 个文件，全部落在默认 2s 防抖窗口内 → 只触发一次
  await writeMd("f1.md", "# F1");
  await sleep(100);
  await writeMd("f2.md", "# F2");
  await sleep(100);
  await writeMd("f3.md", "# F3");
  await waitFor(() => spy.calls() === 1, 8_000);
  await sleep(1_000); // 再等一段确认没有第 2 次
  expect(spy.calls()).toBe(1);
  w.stop();
});

test("60s 兜底轮询：监听失效（手动移除 watcher）时轮询兜回变更", async () => {
  const initialCount = await initialIndex();
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    pollIntervalMs: 500, // 注入加速（真实默认 60s）
  });
  // 模拟监听失效：只关 fs.watch 句柄，60s 轮询兜底仍在
  w.fsWatcher!.close();
  await writeMd("poll.md", "# 轮询兜回\n内容");
  await waitFor(() => store.getKb(kbId)!.chunkCount > initialCount, 10_000);
  w.stop();
});

test("更新合并：进行中标记 dirty，完成后自动重跑一次", async () => {
  await initialIndex();
  const spy = spyIndexFn();
  // 第一次调用挂在 runIndex 进行中写 b.md：其 fs.watch 事件在防抖到期时
  // 第一轮未完成 → dirty 置位，第一轮完成后自动重跑一次
  let first = true;
  const fn: NonNullable<WatchKbOptions["indexFn"]> = async (c, id, signal) => {
    const r = await spy.fn(c, id, signal);
    if (first) {
      first = false;
      void writeMd("b.md", "# B\n内容B");
      await sleep(1_200); // > 2×debounce(400ms)：防抖到期时第一轮仍在进行
    }
    return r;
  };
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    indexFn: fn,
    debounceMs: 400,
  });
  await writeMd("a-new.md", "# AN\n内容AN");
  await waitFor(() => spy.calls() === 2, 15_000);
  expect(spy.calls()).toBe(2); // 第二轮已把 b.md 吸收，无第 3 次
  await sleep(1_000);
  expect(spy.calls()).toBe(2);
  w.stop();
});

test("启动恢复：status=indexing 的库置 error，autoWatch=1 且 ready 的库挂监听", async () => {
  const readyId = kbId;
  const initialCount = await initialIndex(); // ready + autoWatch 默认开
  const stuckId = store.createKb({ folderPath: srcDir }).id;
  store.updateStatus(stuckId, "indexing"); // 模拟上次崩溃残骸
  const restored = restoreWatchers(ctx, { embedFn: fakeEmbed, debounceMs: 400 });
  try {
    expect(store.getKb(stuckId)!.status).toBe("error");
    // ready 库监听已挂：写文件后自动索引到新内容
    await writeMd("restored.md", "# 恢复后新增\n内容");
    await waitFor(() => store.getKb(readyId)!.chunkCount > initialCount, 10_000);
  } finally {
    restored.stopAll();
  }
});

test("autoWatch=false 的库不挂监听", async () => {
  const initialCount = await initialIndex();
  store.setAutoWatch(kbId, false);
  const restored = restoreWatchers(ctx, {
    embedFn: fakeEmbed,
    debounceMs: 400,
    pollIntervalMs: 800,
  });
  try {
    await writeMd("no-watch.md", "# 不该被自动索引\n内容");
    // 观察窗口盖过防抖 + 两轮轮询：无监听则不会触发
    await sleep(2_500);
    expect(store.getKb(kbId)!.chunkCount).toBe(initialCount);
    expect(store.getKb(kbId)!.status).toBe("ready");
    expect(store.getJob(kbId)).toBeNull();
  } finally {
    restored.stopAll();
  }
});

test("重入协调：手动索引进行中的变更不丢，手动完成后 watcher 自动补跑", async () => {
  await initialIndex();
  // 手动更新走与 ws-server 完全相同的真实 runIndex 路径；慢嵌入让 job 行稳定挂住 800ms
  const slowEmbed: EmbedFn = async (texts) => {
    await sleep(800);
    return texts.map(() => new Uint8Array(EMBED_DIM).fill(128));
  };
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    debounceMs: 300,
    pollIntervalMs: 400, // 轮询在手动索引期间参与竞争：基线不得被提前推进
  });
  // 改 a.md → 手动任务快筛失效需重嵌（慢嵌入挂住）；job 行在，watcher 触发必遭重入拒绝
  writeFileSync(
    join(srcDir, "a.md"),
    "# A1\n\n内容甲第一段。\n\n# A2\n\n内容乙第二段。\n\n# A3\n\n新增第三节。",
  );
  const manual = runIndex(ctx, kbId, slowEmbed);
  await sleep(150); // 手动轮扫描已过（起跑头几毫秒）：此刻写入属「手动索引期间的编辑」
  await writeMd("new.md", "# 新章节\n内容");
  await manual; // 手动任务完成（job 行删除）——new.md 尚未被任何一轮索引
  const afterManual = store.getKb(kbId)!.chunkCount;
  // watcher 在手动完成后 ≤debounce+ε 自动补跑消化 new.md——不丢失（丢失则此处超时）
  await waitFor(() => store.getKb(kbId)!.chunkCount > afterManual, 10_000);
  expect(store.getJob(kbId)).toBeNull();
  w.stop();
});

test("cancelIndex 仅中止当前轮自动索引，watcher（监听/轮询）继续存活", async () => {
  await initialIndex();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    debounceMs: 20,
    pollIntervalMs: 50,
    // 阻塞式 indexFn：真实 runIndex 前先挂在 gate 上，模拟一轮进行中的自动索引
    indexFn: async (c, id, signal) => {
      calls++;
      await gate;
      return await runIndex(c, id, fakeEmbed, signal);
    },
  });
  try {
    await writeMd("cancelled.md", "# 取消目标\n内容");
    await waitFor(() => calls === 1, 5_000); // 轮询发现变更 → 防抖 → 自动索引起跑并挂住
    expect(w.indexing).toBe(true);

    w.cancelIndex();
    release(); // 放行当前轮：signal 已 aborted，runIndex 走取消收尾（恢复 ready、删 job）
    await waitFor(() => !w.indexing, 5_000);
    expect(w.stopped).toBe(false); // watcher 未被拆：监听/轮询继续接后续变更
    expect(w.fsWatcher).not.toBeNull();
    expect(store.getJob(kbId)).toBeNull();
    expect(store.getKb(kbId)!.status).toBe("ready");
  } finally {
    w.stop();
  }
});

test("基线推进判定：只有成功才推进——取消（正常 resolve）与失败都不推进", () => {
  // runIndex 取消是「正常 resolve 但 ok:false」，若不判定 ok 就推进基线，
  // 这批变更会被标记为已消化，轮询再也无法兜回（审查发现的静默丢变更）
  expect(shouldAdvanceBaseline({ ok: true, cancelled: false })).toBe(true);
  expect(shouldAdvanceBaseline({ ok: false, cancelled: true })).toBe(false);
  expect(shouldAdvanceBaseline({ ok: false, cancelled: false })).toBe(false);
});

test("取消后同批变更不被轮询立刻重试（尊重用户取消），新变更到来仍能触发", async () => {
  const initialCount = await initialIndex();
  let calls = 0;
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    pollIntervalMs: 300,
    debounceMs: 200,
    indexFn: async (_c, _id, _signal) => {
      calls++;
      if (calls === 1) {
        // 首轮：用户取消（runIndex 取消语义 = 正常 resolve + ok:false）
        return { ok: false, cancelled: true, filesTotal: 1, filesDone: 0, chunkCount: initialCount, failedCount: 0 };
      }
      return runIndex(ctx, kbId, fakeEmbed) as Promise<IndexResult>;
    },
  });
  await writeMd("b.md", "# B\n\n取消前的新文件。");
  await waitFor(() => calls >= 1, 4000);
  // 跨过多个轮询周期：同批变更不得自动重试（否则「取消」形同虚设）
  await sleep(1200);
  expect(calls).toBe(1);
  // 新变更到来：基线未推进 → 差异重新触发，且这轮会把取消前那批一起索引
  await writeMd("c.md", "# C\n\n又一个文件。");
  await waitFor(() => calls >= 2, 6000);
  await waitFor(() => {
    const db = openKbDb(waPiDir, kbId);
    try {
      const n = (db.query("SELECT COUNT(*) c FROM chunks WHERE file_path = 'b.md'").get() as { c: number }).c;
      return n > 0;
    } finally {
      db.close();
    }
  }, 6000);
  w.stop();
});

test("轮询兜底不清理 owner 存活的活任务 job 行", async () => {
  const initialCount = await initialIndex();
  let calls = 0;
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    pollIntervalMs: 200,
    debounceMs: 150,
    indexFn: async () => {
      calls++;
      return { ok: true, cancelled: false, filesTotal: 0, filesDone: 0, chunkCount: initialCount, failedCount: 0 };
    },
  });
  store.startJob(kbId, "extracting", { owner: "proc-a" });
  // 心跳直接推到 20 分钟前（远超 10 分钟阈值）：这是「只看多久没进度」的旧判定必判卡死的前提，
  // 也就是这条用例能真正锁住需求 6 的关键。必须走 SQL 直写——updateJobProgress 会刷新心跳，
  // 造不出旧心跳（旧实现还会忽略 heartbeatAt 第三参、照样写 now）。
  const stale = Date.now() - 20 * 60_000;
  reg.run(`UPDATE indexing_jobs SET heartbeat_at = ?, last_progress_at = ? WHERE kb_id = ?`, [
    stale,
    stale,
    kbId,
  ]);
  await sleep(900); // 跨过 4 个 200ms 轮询周期
  expect(store.getJob(kbId)).not.toBeNull(); // 活任务的 job 行不得被清
  expect(calls).toBe(0); // 更不该因此触发一轮重索引
  w.stop();
});

// I-01 回归锁：轮询单飞。异步化后单轮快照可能超过 pollIntervalMs（网络盘 10 万文件分钟级），
// setInterval 会按时起新的一轮叠罗汉，且慢的旧快照晚到还会覆盖 lastSnapshot 制造虚假差异。
// 这条用例把「任一时刻最多一个快照在跑」钉死：挂住第一轮后，多个轮询间隔内不得再进入第二次。
test("轮询单飞：上一轮快照未结束时后续间隔不再进入（防叠罗汉）", async () => {
  await initialIndex();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const w = watchKb(ctx, kbId, {
    embedFn: fakeEmbed,
    pollIntervalMs: 30,
    debounceMs: 30,
    // 仅测试注入口：缺省是 takeSnapshot（真实扫描）。这里第一轮挂住，直到本用例 release
    snapshotFn: async () => {
      calls++;
      await gate;
      return "hanged";
    },
  });
  await sleep(300); // 跨过约 10 个轮询间隔
  expect(calls).toBe(1); // 单飞：挂住期间后续间隔全部跳过，不得叠罗汉
  release();
  await sleep(150); // 释放后恢复：证明守卫不会把轮询永久钉死
  expect(calls).toBeGreaterThan(1);
  w.stop();
});
