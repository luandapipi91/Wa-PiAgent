import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { runIndex, type KbContext, type EmbedFn, type IndexResult } from "../src/knowledge/indexer";
import { watchKb, restoreWatchers, type WatchKbOptions } from "../src/knowledge/watcher";
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
