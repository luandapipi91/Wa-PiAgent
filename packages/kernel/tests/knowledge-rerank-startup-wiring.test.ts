// 深度重排「启动恢复」的接线测试（2026-11-12 缺陷回归门）。
//
// 缺陷现象：开关持久化在 settings.json，模型就绪态只活在进程内存。重启后没人按开关
// 恢复加载 → 状态恒 idle；前端 idle 文案是「未开启」，于是菜单里出现
// 「开关已开 + 未开启」的自相矛盾展示，deep 检索静默退化 hybrid。
//
// knowledge-reranker.test.ts 只测 prepareRerankerIfEnabled 本身（纯函数层），
// 钉不住「startKernel 真的在启动时调用了它」——接线漏了那边照样全绿。故本文件启动
// 完整 kernel 断言状态自动进入 ready。
//
// 用 setRerankerLoaderForTest 注入 fake loader（不联网、不依赖本机模型缓存），
// 同时借它证明「确实走了加载路径」（loader 被调用次数）。
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时读 env，故用动态 import() 延后加载。
// 本文件会启动完整 kernel → 登记在 scripts/test.ts 的 INTEGRATION_TESTS，单独进程跑。
import { test, expect, afterAll } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
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

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-rerank-wiring-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");
const { setRerankerLoaderForTest, rerankerStatus } = await import(
  "../src/knowledge/reranker"
);

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

// 启动前写入 settings：开关已开启（模拟「上次用着开着，然后重启」）
await writeFile(
  join(TMP_ROOT, "settings.json"),
  JSON.stringify({ knowledgeRerank: { enabled: true } }, null, 2),
  "utf8",
);

// fake loader：不联网，返回最小可用的 tokenizer + 分类模型形状
let loaderCalls = 0;
setRerankerLoaderForTest(async () => {
  loaderCalls += 1;
  return {
    tokenizer: () => ({}),
    model: async () => ({
      logits: { data: new Float32Array([0]), dims: [1, 1] },
    }),
  };
});

let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
  try {
    if (stopHandle) await stopHandle();
  } catch {
    /* 忽略关闭失败 */
  }
  setRerankerLoaderForTest(null);
  process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
  process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
  process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
  process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
  process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
  process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
  process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
  await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

test("settings 已开启时，kernel 启动会自动恢复加载模型（状态进 ready，不需手动重试）", async () => {
  // 前置不变量：进程内还没有任何加载（重启后的初始态就是 idle）
  expect(rerankerStatus().status).toBe("idle");

  const started = await startKernel({ port: await getFreePort() });
  stopHandle = started.stop;

  // 启动恢复是后台任务（不阻塞启动）：轮询到终态
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && rerankerStatus().status === "idle") {
    await new Promise((r) => setTimeout(r, 100));
  }

  expect(rerankerStatus().status).toBe("ready");
  expect(loaderCalls).toBe(1);
});
