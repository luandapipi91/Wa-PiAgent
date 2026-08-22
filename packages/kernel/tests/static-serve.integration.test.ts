// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时从 env 读取 WA_PI_DIR，
// 一旦确定便不可改。ESM 静态 import 会被提升，所以这里用动态 import()
// 把 env 设置放在第一个 kernel 模块加载之前，确保 startKernel 写入的是测试临时目录
// 而非真实 ~/.wa-pi。
import { test, expect, afterAll } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// 保存原始 env：startKernel/本文件会修改 process.env（WA_PI_DIR、HTTP_PROXY 等），
// bun test --isolate 只隔离 global object 不隔离 process.env，不恢复会污染同一
// worker 进程后续测试文件（后续测试的 fetch 会走死代理/错误 WA_PI_DIR）。
const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	HTTP_PROXY: process.env.HTTP_PROXY,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	http_proxy: process.env.http_proxy,
	https_proxy: process.env.https_proxy,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = await mkdtemp(join(tmpdir(), "wa-pi-static-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");

const TMP_STATIC = `${import.meta.dir}/.tmp-static`;

// 获取一个临时空闲端口供 startKernel 使用，避免与正在运行的 wa-pi（9776）冲突。
// 接受 listen(0) → close → 复用端口之间的微小竞争窗口（测试可接受）。
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

let usedPort = 0;
let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
  // 尽力关 server，避免端口残留（关闭失败不阻塞清理）
  try { if (stopHandle) await stopHandle(); } catch { /* 忽略关闭失败 */ }
  // 恢复被污染的 env（Bun 的代理变量 delete 清不掉，统一赋回原值或空串）
  process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
  process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
  process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
  process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
  process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
  process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
  process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
  await rm(TMP_STATIC, { recursive: true, force: true });
  await rm(TMP_ROOT, { recursive: true, force: true });
});

// happy-dom（root 测试环境的全局 preload）会替换 globalThis.fetch，
// 其底层 Node HTTP 解析器无法解析本 server 的响应(HPE_UNEXPECTED_CONTENT_LENGTH)。
// 本测试只在原生 fetch 环境下有意义（如 `cd packages/kernel && bun test`，
// 或 build.ts 测试钩子里单独从 kernel 目录跑）。happy-dom 下自跳过。
const HAPPY_DOM_ACTIVE =
  typeof (globalThis as any).document !== "undefined" ||
  typeof (globalThis as any).window !== "undefined";
const maybeTest: typeof test = HAPPY_DOM_ACTIVE ? (test.skip as typeof test) : test;

maybeTest("静态伺服：返回 index.html 与资产", async () => {
  await mkdir(`${TMP_STATIC}/assets`, { recursive: true });
  await writeFile(`${TMP_STATIC}/index.html`, "<html>ok</html>");
  await writeFile(`${TMP_STATIC}/assets/x.js`, "console.log(1)");
  const freePort = await getFreePort();
  const started = await startKernel({ staticDir: TMP_STATIC, port: freePort });
  usedPort = started.port;
  stopHandle = started.stop;
  const root = await (await fetch(`http://127.0.0.1:${usedPort}/`)).text();
  const asset = await (await fetch(`http://127.0.0.1:${usedPort}/assets/x.js`)).text();
  expect(root).toBe("<html>ok</html>");
  expect(asset).toBe("console.log(1)");
  // 资产形路径但文件缺失：回退 index.html（SPA 路由），不漏 426
  const missing = await (await fetch(`http://127.0.0.1:${usedPort}/assets/does-not-exist.js`)).text();
  expect(missing).toBe("<html>ok</html>");
});
