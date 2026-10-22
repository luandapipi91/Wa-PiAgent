// 离线（模型不可用）下的启动回填接线，以及「回填不阻塞启动」的唯一可判定断言。
//
// 为什么单独一个文件：
//   1) memory-backfill-wiring.test.ts 的核心用例挂在模型门上（模型不可用即整条跳过），
//      而「模型不可用」正是最容易踩「启动失败」的场景 —— 该场景在那边零覆盖；
//   2) 「不阻塞」在模型可用时**无法判定**：实测本机冷加载模型 414ms，而 startKernel 尾部
//      耗时 403ms，回填在 startKernel 返回前就完成了（embeddedCount() 已 =2）——
//      此时 await 与 void 的表现完全一样，任何断言都抓不到回归。
//
// 构造「模型加载永远卡住」（不依赖外网、不依赖本机缓存是否命中）：
//   - WA_PI_HF_ENDPOINT 指向本进程起的**黑洞端点**：listen 后接受连接但永不响应；
//   - env.useFSCache = false：否则 transformers 会直接命中本地 .cache 里的模型，根本不走网络；
//   - 清掉 WA_PI_MODEL_DIR：否则 allowRemoteModels=false 会走本地目录、快速失败，测不出「卡住」。
// 于是模型加载永久 pending：
//   - 正确实现（void 后台任务）：startKernel 迅速返回，返回时 embeddedCount() === 0；
//   - 把 index.ts 的 `void (async …)()` 改成 `await`：startKernel 卡在挂起的 fetch 上永不返回
//     → 本文件 60s 用例超时变红（elapsed 断言是同一回归的快速信号）。
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时读 env，故用动态 import() 延后加载。
// 本文件会启动完整 kernel → 登记在 scripts/test.ts 的 INTEGRATION_TESTS，单独进程跑。
import { test, expect, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

// 保存原始 env：startKernel 会改 process.env（WA_PI_DIR / 代理），不恢复会污染同 worker
const ORIG_ENV = {
  WA_PI_DIR: process.env.WA_PI_DIR,
  WA_PI_MODEL_DIR: process.env.WA_PI_MODEL_DIR,
  WA_PI_HF_ENDPOINT: process.env.WA_PI_HF_ENDPOINT,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-mem-backfill-offline-"));
process.env.WA_PI_DIR = TMP_ROOT;

// 黑洞端点：接受连接但永不响应、也不关闭 → 模型下载永久 pending
const blackholeSockets = new Set<Socket>();
const blackhole = createServer((s) => {
  blackholeSockets.add(s);
  s.on("close", () => blackholeSockets.delete(s));
  s.on("error", () => {
    /* 清理阶段 socket 被销毁属预期 */
  });
});
await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
const blackholePort = (blackhole.address() as { port: number }).port;

process.env.WA_PI_HF_ENDPOINT = `http://127.0.0.1:${blackholePort}`;
delete process.env.WA_PI_MODEL_DIR;
// 黑洞是 127.0.0.1：若被代理接管就不是「卡住」而是立刻失败，会失去判别力
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
  delete process.env[k];
}

const { startKernel } = await import("../src/index");
const { openMemoryDb } = await import("../src/memory/db");
const { MemoryDao } = await import("../src/memory/dao");
const { env } = await import("@huggingface/transformers");

// 关掉 FS 缓存，否则 transformers 命中本机 .cache 里的模型，根本不会去碰黑洞端点
env.useFSCache = false;

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

// 启动前造好存量库：两条未索引记忆（embedding IS NULL）
const db = openMemoryDb(TMP_ROOT);
const dao = new MemoryDao(db);
for (const content of [
  "离线存量甲：模型不可用时词法检索仍要能命中",
  "离线存量乙：回填卡在模型下载也要能起服务",
]) {
  dao.insert({
    kind: "knowledge",
    target: "memory",
    scope: "project",
    projectId: "Wa-Pi",
    content,
    source: "agent",
  });
}

let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
  try {
    if (stopHandle) await stopHandle();
  } catch {
    /* 忽略关闭失败 */
  }
  // 销毁黑洞 socket：否则挂起的 fetch 一直 pending，进程无法干净退出
  for (const s of blackholeSockets) s.destroy();
  blackhole.close();
  process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
  if (ORIG_ENV.WA_PI_MODEL_DIR === undefined) delete process.env.WA_PI_MODEL_DIR;
  else process.env.WA_PI_MODEL_DIR = ORIG_ENV.WA_PI_MODEL_DIR;
  if (ORIG_ENV.WA_PI_HF_ENDPOINT === undefined)
    delete process.env.WA_PI_HF_ENDPOINT;
  else process.env.WA_PI_HF_ENDPOINT = ORIG_ENV.WA_PI_HF_ENDPOINT;
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
    db
      .query("SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL")
      .get() as { n: number }
  ).n;
}

test("模型不可用（离线）时启动不失败、词法可用，且回填不阻塞启动", async () => {
  // 前置不变量：种子在库里、词法通道可用、还没有任何向量
  expect(embeddedCount()).toBe(0);
  expect(dao.search("离线存量甲", { projectScope: "Wa-Pi" }).length).toBeGreaterThan(0);
  expect(dao.search("离线存量乙", { projectScope: "Wa-Pi" }).length).toBeGreaterThan(0);

  const t0 = performance.now();
  const started = await startKernel({ port: await getFreePort() });
  const elapsed = performance.now() - t0;
  stopHandle = started.stop;

  // ① 模型加载被挂住，启动仍成功返回（不是「启动失败」）
  expect(typeof started.stop).toBe("function");
  // ② 回填没有阻塞启动。黑洞端点永不响应：若回填被 await，这里等不到返回（用例超时变红）；
  //    elapsed 是同一回归的快速信号（本机实测 void 版本 ~200ms，留 50 倍余量）
  expect(elapsed).toBeLessThan(10_000);
  // ③ 返回时向量仍未写入：语义通道确实不可用（而不是已经索引完了）
  expect(embeddedCount()).toBe(0);
  // ④ 词法通道不受影响（「只是没有语义通道」，库本身正常）
  expect(dao.search("离线存量甲", { projectScope: "Wa-Pi" }).length).toBeGreaterThan(0);
  expect(dao.search("离线存量乙", { projectScope: "Wa-Pi" }).length).toBeGreaterThan(0);
});
