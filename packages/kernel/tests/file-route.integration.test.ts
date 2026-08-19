import { test, expect, afterAll } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// 保存原始 env：startKernel/本文件会修改 process.env（WA_PI_DIR、HTTP_PROXY 等），
// bun test --isolate 只隔离 global object 不隔离 process.env/模块常量，不恢复会污染
// 同一 worker 进程后续测试文件。
const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	HTTP_PROXY: process.env.HTTP_PROXY,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	http_proxy: process.env.http_proxy,
	https_proxy: process.env.https_proxy,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = await mkdtemp(join(tmpdir(), "wa-pi-file-route-"));
process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");
const { ProjectStore } = await import("../src/project-store");

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

let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
  try { if (stopHandle) await stopHandle(); } catch { /* 忽略关闭失败 */ }
  // 恢复被污染的 env（Bun 的代理变量 delete 清不掉，统一赋回原值或空串）
  process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
  process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
  process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
  process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
  process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
  process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
  process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
  await rm(TMP_ROOT, { recursive: true, force: true });
});

const HAPPY_DOM_ACTIVE =
  typeof (globalThis as any).document !== "undefined" ||
  typeof (globalThis as any).window !== "undefined";
const maybeTest: typeof test = HAPPY_DOM_ACTIVE ? (test.skip as typeof test) : test;

maybeTest("/file 对 .webm 返回 audio/webm 类型", async () => {
  const projectCwd = join(TMP_ROOT, "proj");
  const uploadsDir = join(projectCwd, ".wa-pi", "uploads");
  await mkdir(uploadsDir, { recursive: true });

  const projectStore = new ProjectStore();
  await projectStore.createProject({ name: "test", cwd: projectCwd });

  const filePath = join(uploadsDir, "recording.webm");
  await writeFile(filePath, "fake-webm-data");

  const freePort = await getFreePort();
  const started = await startKernel({ port: freePort });
  stopHandle = started.stop;

  const resp = await fetch(`http://127.0.0.1:${started.port}/file?path=${encodeURIComponent(filePath)}`);
  expect(resp.status).toBe(200);
  expect(resp.headers.get("content-type")).toBe("audio/webm");
});
