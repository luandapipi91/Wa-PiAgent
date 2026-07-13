import { test, expect, afterAll } from "bun:test";
import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const TMP_ROOT = await mkdtemp(join(tmpdir(), "hiagent-file-route-"));
process.env.HIAGENT_DIR = TMP_ROOT;

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
  try { if (stopHandle) await stopHandle(); } catch {}
  await rm(TMP_ROOT, { recursive: true, force: true });
});

const HAPPY_DOM_ACTIVE =
  typeof (globalThis as any).document !== "undefined" ||
  typeof (globalThis as any).window !== "undefined";
const maybeTest: typeof test = HAPPY_DOM_ACTIVE ? (test.skip as typeof test) : test;

maybeTest("/file 对 .webm 返回 audio/webm 类型", async () => {
  const projectCwd = join(TMP_ROOT, "proj");
  const uploadsDir = join(projectCwd, ".hiagent", "uploads");
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
