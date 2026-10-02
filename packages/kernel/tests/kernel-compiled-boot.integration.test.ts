// 打包形态冒烟：真编译内核二进制、真把它启动起来、等它监听端口。
//
// 为什么必须有这道防线（本轮 P0）：打包版内核启动时"静默退出（code 0）、应用永远不就绪"
// 这类问题在源码/dev 形态**完全不复现**——单测、typecheck、E2E 全绿也照样出坏包；
// 只有"真编译 + 真启动"才抓得到。（本轮根因就是启动关键路径上执行了磁盘上的 JS 模块，
// 在 bun --compile 产物里挂住，见 pi-catalog.ts 头部说明。）
//
// 注册在 scripts/test.ts 的 INTEGRATION_TESTS（单独进程补跑，不并入主批）。
// 启动时 cwd 指向 packages/kernel：pi 的包从这里 node_modules 解析（等价打包运行时用
// <WA_PI_DIR>/runtime 里的依赖）；WA_PI_DIR / 端口 / web 目录全部隔离，互不污染。
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileKernelBinary,
  kernelBinaryName,
} from "../scripts/compile-binary.ts";

const KERNEL_PKG_DIR = join(import.meta.dir, "..");
const cleanup: string[] = [];
let child: ChildProcess | null = null;

afterAll(async () => {
  if (child && !child.killed) {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      child.kill("SIGKILL");
    }
  }
  // 等被杀进程释放文件句柄（Windows 上 exe 常被杀后仍被占用一小会儿）
  await new Promise((r) => setTimeout(r, 500));
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* 临时目录残留无害；不要因清理失败把用例标红 */
    }
  }
});

/**
 * 找一个能真编译的 bun。
 *
 * 本机可能把「应用放的 bun shim」放在 PATH 首位（它 set BUN_BE_BUN=1 后直接跑打包内核），
 * 那时 process.execPath 是编译产物自己，`bun build --compile` 会报 SectionExists。
 * 优先用 WA_PI_PI_RUNTIME（桌面端会给子进程注入真 bun 路径）与 PATH 上真正的 bun；
 * 都拿不到就跳过本测试并明确打日志（不静默通过）。
 */
function resolveCompilerBun(): string | null {
  const looksLikeBun = (p: string) => /(^|[\\/])bun(\.exe)?$/i.test(p);
  const candidates = [
    process.env.WA_PI_PI_RUNTIME,
    Bun.which("bun"),
    // bun 官方安装器的默认位置（Windows：~/.bun/bin/bun.exe）——PATH 上只剩 shim 时的兼底
    join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
    process.execPath,
  ];
  for (const candidate of candidates) {
    if (candidate && looksLikeBun(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 取一个当前空闲的端口（先绑 0 再释放） */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 TCP 连接，直到端口可连或超时 */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test(
  "编译产物能启动并监听端口（源码形态不复现的那类问题）",
  async () => {
    const compiler = resolveCompilerBun();
    if (!compiler) {
      console.warn(
        "[skip] 找不到真正的 bun（PATH 上可能是桌面端 shim）——无法编译内核产物，跳过本冒烟。",
      );
      return;
    }

    // 1) 真编译
    const binDir = mkdtempSync(join(tmpdir(), "wa-kernel-boot-"));
    cleanup.push(binDir);
    const outfile = join(binDir, kernelBinaryName());
    const target =
      process.platform === "win32"
        ? "win"
        : process.platform === "linux"
          ? "linux"
          : "darwin";
    expect(existsSync(compiler)).toBe(true);
    compileKernelBinary(outfile, target, compiler);
    expect(existsSync(outfile)).toBe(true);

    // 2) 真启动（隔离数据目录 / 端口 / web 目录）
    const waDir = mkdtempSync(join(tmpdir(), "wa-kernel-boot-data-"));
    cleanup.push(waDir);
    const webDir = join(waDir, "web");
    mkdirSync(webDir, { recursive: true });
    const port = await freePort();

    let output = "";
    child = spawn(outfile, [], {
      cwd: KERNEL_PKG_DIR,
      env: {
        ...process.env,
        WA_PI_DIR: waDir,
        WA_PI_WS_PORT: String(port),
        WA_PI_WEB_DIR: webDir,
        // 打包形态下由 app 剥掉；留着会让编译产物当 bun CLI 跑（打印 usage 后 code=0 退出）
        BUN_BE_BUN: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d) => {
      output += d.toString();
    });

    const ready = await waitForPort(port, 60000);
    if (!ready) {
      const exited = child.exitCode !== null;
      throw new Error(
        `编译产物 60s 内未就绪（进程已退出=${exited} exitCode=${child.exitCode}）。` +
          `产物输出：\n${output.slice(-2000)}`,
      );
    }
    expect(ready).toBe(true);
  },
  180000,
);
