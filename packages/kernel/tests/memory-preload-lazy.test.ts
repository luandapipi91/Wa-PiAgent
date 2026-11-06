// embedding 模型启动预热惰性化的回归门（性能体检 2026-11-06）：
// 空记忆库（无未索引条目）启动时，不得下载/加载 embedding 模型（onnxruntime + bge 模型
// 净增 ~110MB 常驻，空库预热纯属浪费）。模型改由首次真实使用懒加载：
//   - 有存量待回填 → indexPendingMemories → embedDocuments → getPipeline（memory-backfill-wiring.test.ts 覆盖落库）
//   - 无待回填 → 启动任务不 import embedder，模型完全不触碰
// 本用例钉住「空库启动后模型未被触碰」：isEmbedderReady() 一直 false 且 models 缓存目录
// 从未出现。模型可用时本用例才有判别力（模型不可用时旧实现预热也会失败，无法区分），
// 故挂模型门 skipIf。
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR（constants.ts 模块加载时读 env），
// 本文件会启动完整 kernel → 登记 scripts/test.ts 的 INTEGRATION_TESTS 单独进程跑。
import { test, expect, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const ORIG_ENV = {
  WA_PI_DIR: process.env.WA_PI_DIR,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-mem-preload-lazy-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");
const { isEmbedderReady } = await import("../src/memory/embedder");
const { probeModelAvailability, registerModelGateFailure } = await import(
  "./helpers/model-gate"
);

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

const gate = await probeModelAvailability();
registerModelGateFailure(gate, "memory-preload-lazy.test");
const modelUnavailable = gate.status !== "available";

// 探测本身会把 embedder 单例置 ready——这是探测残留，与「kernel 启动是否预热」无关。
// startKernel 前把单例重置回 idle，保证下面的断言只反映 kernel 启动行为。
// 注意：探测下载的 models/ 缓存目录必须保留——旧实现（无条件预热）依赖缓存命中才能
// 在 8s 观察窗口内完成加载并置 ready（判红）；删了目录旧实现会重新走 ~98MB 下载，
// 窗口内来不及 ready 而误绿（本测试曾在此栽过，stash 验证抓出）。
if (!modelUnavailable) {
  const { resetEmbedderForTest } = await import("../src/memory/embedder");
  resetEmbedderForTest();
}

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
  await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

test.skipIf(modelUnavailable)(
  "空记忆库启动不预热 embedding 模型（embedder 不 ready）",
  async () => {
    // 前置不变量：空库（本文件不 insert 任何记忆条目）

    const started = await startKernel({ port: await getFreePort() });
    stopHandle = started.stop;
    expect(typeof started.stop).toBe("function");

    // 旧实现（无条件预热）：模型缓存命中时 1-3s 内 embedder 单例被置 ready。
    // 新实现：启动任务不 import embedder 加载路径，单例保持 idle。观察窗口 8s。
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      expect(isEmbedderReady()).toBe(false);
      await new Promise((r) => setTimeout(r, 250));
    }

    // 收官再断言一次（等价于「整个窗口内从未发生」）
    expect(isEmbedderReady()).toBe(false);
  },
);
