// 必须在任何 kernel/shared 代码 import 之前设置 HIAGENT_DIR：
// packages/shared/src/constants.ts 在模块加载时从 env 读取 HIAGENT_DIR，
// 一旦确定便不可改。ESM 静态 import 会被提升，所以这里用动态 import()
// 把 env 设置放在第一个 kernel 模块加载之前，确保 startKernel 写入的是测试临时目录
// 而非真实 ~/.hiagent。
import { test, expect, afterAll } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = await mkdtemp(join(tmpdir(), "hiagent-static-"));
process.env.HIAGENT_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");

const TMP_STATIC = `${import.meta.dir}/.tmp-static`;
let port = 0;
let serverHandle: { stop?: () => Promise<void> } | null = null;

afterAll(async () => {
  // 尽力关 server，避免端口残留
  try { if (serverHandle?.stop) await serverHandle.stop(); } catch {}
  await rm(TMP_STATIC, { recursive: true, force: true });
  await rm(TMP_ROOT, { recursive: true, force: true });
});

test("静态伺服：返回 index.html 与资产", async () => {
  await mkdir(`${TMP_STATIC}/assets`, { recursive: true });
  await writeFile(`${TMP_STATIC}/index.html`, "<html>ok</html>");
  await writeFile(`${TMP_STATIC}/assets/x.js`, "console.log(1)");
  // startKernel 返回 { port }；同时尝试拿到 server 句柄用于 afterAll 清理
  const started = await startKernel({ staticDir: TMP_STATIC }) as { port: number; stop?: () => Promise<void> };
  port = started.port;
  serverHandle = started as any;
  const root = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const asset = await (await fetch(`http://127.0.0.1:${port}/assets/x.js`)).text();
  expect(root).toBe("<html>ok</html>");
  expect(asset).toBe("console.log(1)");
});
