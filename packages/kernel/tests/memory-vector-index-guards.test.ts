/**
 * vector-index 的「异常兜底」与「终止性」持久守护。
 *
 * 这两条是 vector-index.ts 里风险最高的行为，却都是静默的：
 *  - 推理异常兜底：删掉 try/catch 后，后台调用会抛未捕获 promise rejection；
 *  - 空批次终止：把 `break` 改回 `continue` 后，待索引集合不变 → 同步死循环
 *    （连 setTimeout 都排不动，测试不是变红而是**挂死**，比失败更糟）。
 *
 * ⚠️ 本文件用 mock.module 替换 ../src/memory/embedder。Bun 1.4 的 mock.module
 * 无恢复 API（返回 undefined），且 --isolate 不隔离 module cache（同 worker 同 PID），
 * 会泄漏给同批后续文件。因此本文件登记进 scripts/test.ts 的 MOCK_LEAKY_TESTS：
 * 主批用 --path-ignore-patterns 排除，再以独立进程补跑（与 fs-open-env.test.ts
 * 同一策略）。单独运行 `bun test tests/memory-vector-index-guards.test.ts` 亦可独立通过。
 */
import { test, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { loadVectorExtension, initVectorColumn } from "../src/memory/vector-ext";

/** mock 状态（工厂函数在 import 求值时就可能被调用，故先把容器备好） */
const state = {
  calls: 0,
  impl: (async () => []) as () => Promise<Uint8Array[]>,
  ready: true,
};

const FINGERPRINT = "mock-model:q8:512";

mock.module("../src/memory/embedder", () => ({
  embedFingerprint: () => FINGERPRINT,
  isEmbedderReady: () => state.ready,
  embedDocuments: async () => {
    state.calls++;
    return state.impl();
  },
}));

import { MemoryDao } from "../src/memory/dao";
import { indexPendingMemories } from "../src/memory/vector-index";

let db: Database;
let dao: MemoryDao;

beforeEach(() => {
  state.calls = 0;
  state.impl = async () => [];
  state.ready = true;
  db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  loadVectorExtension(db);
  initVectorColumn(db);
  dao = new MemoryDao(db);
});

function add(content: string) {
  return dao.insert({ kind: "knowledge", target: "memory", scope: "project", projectId: "Wa-Pi", content, source: "agent" });
}

test("embedDocuments 抛错：后台索引不外抛、不谎报成功，且能再次调用", async () => {
  add("一条待索引内容");
  state.impl = async () => {
    throw new Error("native binding boom");
  };

  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", onRejection);
  // 生产代码会打诊断日志（预期行为），测试期间静音以免污染输出
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await indexPendingMemories(dao, { batchSize: 8 });
    // 不谎报成功：一条都没索引，且明确标记本轮 skipped
    expect(res).toEqual({ indexed: 0, failed: 0, skipped: true });
    // 再调一次：证明 running 标记已复位，不会永久卡死
    const again = await indexPendingMemories(dao, { batchSize: 8 });
    expect(again.skipped).toBe(true);
    // 放一个宏任务，让潜在未捕获 rejection 浮出来
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.error = realError;
    process.off("unhandledRejection", onRejection);
  }

  expect(rejections).toEqual([]);
  expect(dao.listUnindexed(10)).toHaveLength(1); // 未写入 → 下轮可重试
});

test("模型可用但整批编不出向量：本轮终止，不空转", async () => {
  add("一");
  add("二");
  state.ready = true; // 模型可用 → 走「空批次」分支（而非 skipped 分支）
  state.impl = async () => {
    // 回归检测：`continue` 会立刻重取同一批 → embedding 调用次数迅速增长。
    // 这里设硬上限，把「挂死」转成「断言失败」（同步死循环连超时都排不动）。
    if (state.calls > 50) {
      throw new Error("spinning: 待索引集合未推进，疑似把 break 改回了 continue");
    }
    return [];
  };

  const res = await indexPendingMemories(dao, { batchSize: 8 });

  expect(state.calls).toBe(1); // 只取一批就必须结束（回归时 >50）
  expect(res.skipped).toBe(false); // 模型可用，不是 skipped 分支
  expect(res.failed).toBe(2); // 两条都计入失败
  expect(dao.listUnindexed(10)).toHaveLength(2); // 未被写入，可下轮重试
});
