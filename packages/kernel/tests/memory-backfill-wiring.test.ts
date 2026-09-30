// 启动回填接线：验证 startKernel 启动时真的会把未索引的记忆补齐
//（`indexPendingMemories` 本身由 memory-vector-index.test.ts / memory-semantic-e2e.test.ts
// 覆盖，这里只验证「接线」）。
// 因此必须真跑 startKernel：启动前在 WA_PI_DIR 的库里放未索引条目（embedding IS NULL，
// 模拟存量库升级到 v3 后的状态），启动后轮询断言 embedding 已落库。
//
// 「回填不阻塞启动」与「离线/无模型下启动不失败」**不在本文件断言**，因为它们只有
// 在回填被拖慢时才可判定（模型可用时回填会在 startKernel 尾部就跑完，实测本机冷加载
// 模型 414ms、尾耗时 403ms，await 与 void 表现完全一致），故另开
// tests/memory-backfill-offline.test.ts 用「挂起的模型下载」来判定。
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时读 env，故用动态 import() 延后加载。
// 本文件会启动完整 kernel → 已登记在 scripts/test.ts 的 INTEGRATION_TESTS，单独进程跑
//（轮询等待回填，需 scripts/test.ts 传入的 --timeout=60000，勿用裸 bun test 默认 5s 跑）
import { test, expect, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// 保存原始 env：startKernel 会改 process.env（WA_PI_DIR / 代理），不恢复会污染同 worker
const ORIG_ENV = {
  WA_PI_DIR: process.env.WA_PI_DIR,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-mem-backfill-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");
const { openMemoryDb } = await import("../src/memory/db");
const { MemoryDao } = await import("../src/memory/dao");
const { embedQuery } = await import("../src/memory/embedder");

/** 取空闲端口，避免与运行中的 wa-pi（9776）冲突 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close();
        reject(new Error("无法获取空闲端口"));
      }
    });
  });
}

// 模型可用性门：本用例核心断言就是「启动回填把 embedding 写进去了」，没有模型不可能成立。
// 门只加在这一条上（同文件其余断言不依赖模型）。
const modelUnavailable = (await embedQuery("可用性探测")) === null;

if (modelUnavailable) {
  console.warn(
    "[memory-backfill-wiring.test] 跳过依赖模型的用例：embedding 模型不可用。\n" +
      "  原因：模型加载失败（离线 / 无法访问 hf-mirror.com / 未随包内置模型）。\n" +
      "  请在有网络的机器上重跑，或设置 WA_PI_MODEL_DIR 指向本地模型目录。",
  );
}

// 启动前造好存量库：两条未索引记忆（embedding IS NULL）
const { db: seedDb, dao: seedDao } = (() => {
  const db = openMemoryDb(TMP_ROOT);
  const dao = new MemoryDao(db);
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "过期记忆甲：启动后应被后台回填补齐向量",
    source: "agent",
  });
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content: "过期记忆乙：词法通道在回填完成前就该能命中",
    source: "agent",
  });
  return { db, dao };
})();

let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
  try {
    if (stopHandle) await stopHandle();
  } catch {
    /* 忽略关闭失败 */
  }
  process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
  process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
  process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
  process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
  process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
  process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
  process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
  await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {}); // startKernel().stop() 不停 fs.watch 等句柄，Windows 锁目录到进程退出，清理尽力而为
});

/** 库里已落向量的条数 */
function embeddedCount(): number {
  return (
    seedDb
      .query("SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL")
      .get() as { n: number }
  ).n;
}

test.skipIf(modelUnavailable)(
  "存量库的未索引记忆在启动后被后台回填（接线）",
  async () => {
  // 前置不变量：回填前确实一条向量都没有（否则本用例证明不了任何事）
  expect(embeddedCount()).toBe(0);
  // 词法通道在回填完成前就该能用（规格 §7 验收 5）
  expect(
    seedDao.search("过期记忆甲", { projectScope: "Wa-Pi" }).length,
  ).toBeGreaterThan(0);

  const started = await startKernel({ port: await getFreePort() });
  stopHandle = started.stop;
  // startKernel 正常返回、后台回填随后才写入（“不阻塞”的真断言在 memory-backfill-offline.test.ts：
  // 这里回填往往在 startKernel 尾部就跑完了，断言不了阻塞与否）
  expect(typeof started.stop).toBe("function");

  // 后台回填是异步的：轮询等待 embedding 落库（首次模型加载约 1-3s，留足余量）
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && embeddedCount() < 2) {
    await new Promise((r) => setTimeout(r, 200));
  }

  // 回填后：两条都带上向量，且 listUnindexed 清空
  expect(embeddedCount()).toBe(2);
  expect(seedDao.listUnindexed(10)).toHaveLength(0);

    // 词法通道不因回填受影响（规格 §7 验收 2）
    expect(seedDao.search("过期记忆甲", { projectScope: "Wa-Pi" }).length).toBeGreaterThan(0);
  },
);
