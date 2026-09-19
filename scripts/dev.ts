// 一键启动:并行起 kernel(9776 WS)+ frontend(Vite 5180),自动开浏览器,SIGINT 清理,按 R 重载前后端。
import { spawn, type ChildProcess } from "node:child_process";
import { killPort, findAvailablePort } from "./port";
import { openBrowser } from "./open-browser";
import { waitFrontendReady } from "./frontend-ready";
// @wa-pi/shared 改为动态 import:静态 import 在 node_modules 缺失时会直接崩,
// 无法进入自修复流程。改为运行时检测 + 自动 bun install(见 ensureDeps)。

/**
 * 自修复:检测 @wa-pi/shared 是否可解析,缺失则自动 bun install 后重启自身进程。
 * 必须重启 —— bun 在进程启动时缓存 node_modules 解析结果,同进程内即使 install
 * 重建了 workspace symlink,import 仍命中"找不到"缓存。WA_PI_DEPS_REPAIRED 防死循环。
 */
async function ensureDeps(): Promise<void> {
  try {
    await import("@wa-pi/shared");
    return; // 已就绪
  } catch {
    // 缺失,走修复
  }
  if (process.env.WA_PI_DEPS_REPAIRED === "1") {
    console.error(
      "[dev] 上次 bun install 后 @wa-pi/shared 仍无法解析,请手动运行 `bun install` 排查",
    );
    process.exit(1);
  }
  console.log(
    "[dev] 依赖缺失(@wa-pi/shared 无法解析),自动执行 bun install 修复...",
  );
  const code = await runCmdInherit("bun", ["install"]);
  if (code !== 0) {
    console.error("[dev] bun install 失败(退出码 %d),请手动运行排查", code);
    process.exit(1);
  }
  console.log("[dev] 依赖已修复,重启启动脚本以加载新依赖...");
  process.env.WA_PI_DEPS_REPAIRED = "1";
  await relaunchSelf();
}

/** 用新进程重新执行当前脚本,当前进程挂起等待子进程退出后镜像其退出码。 */
function relaunchSelf(): Promise<never> {
  const [exe, script, ...extra] = process.argv;
  const child = spawn(exe, [script, ...extra], { stdio: "inherit" });
  return new Promise<never>((resolve) => {
    child.on("close", (code) => {
      process.exit(code ?? 0);
      resolve();
    });
    child.on("error", (e) => {
      console.error("[dev] 重启失败:", e);
      process.exit(1);
    });
  });
}

/** spawn 并继承 stdio(让 install 进度可见),返回退出码 */
function runCmdInherit(bin: string, args: string[]): Promise<number> {
  const child = spawn(bin, args, { stdio: "inherit", shell: true });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  await ensureDeps();
  // 强制校验 Bun ≥ 1.4.0（必须在 ensureDeps 之后：依赖缺失时先自修复，再检查版本）。
  // 当前代码依赖 bun 1.4 行为（Bun.cron 本地时区解析），1.3.x 下定时任务会静默错 8 小时。
  // 版本不足时不直接退出：尝试自动下载 1.4 bun 到用户缓存并用它重启 dev 自身。
  const shared = await import("@wa-pi/shared");
  const check = shared.checkBunVersion();
  if (!check.ok) {
    console.log(
      "[dev] 当前 Bun 版本不足(需要 ≥1.4.0),尝试自动下载 bun 到本地缓存...",
    );
    const {
      cachedBunPath,
      isUsableBunFile,
      bunVersionOf,
      downloadDevBun,
      prependBunDirToPath,
      relaunchSelfWith,
    } = await import("./bun-dev-runtime");
    let bunExe = isUsableBunFile(cachedBunPath()) ? cachedBunPath() : null;
    if (bunExe) {
      const v = await bunVersionOf(bunExe);
      if (!v || !shared.isBunAtLeast(v)) bunExe = null; // 缓存损坏/过旧 → 重下
    }
    if (!bunExe) bunExe = await downloadDevBun();
    if (bunExe) {
      prependBunDirToPath(bunExe);
      process.env.WA_PI_PI_RUNTIME = bunExe; // pi rpc 子进程跟随下载 bun（resolvePiRuntime env 优先）
      console.log(`[dev] 用下载的 bun 重启: ${bunExe}`);
      const [, script, ...extra] = process.argv;
      await relaunchSelfWith(bunExe, [script, ...extra]);
    }
    shared.assertBunVersionOrExit(); // 下载失败 → 保留原有中文报错退出（兜底）
  }
  // dev 浏览器版 WS 端口写死 9776，故意不走 shared 的 WS_PORT（它会优先读
  // WA_PI_WS_PORT 环境变量）：生产 kernel 固定 9778，若环境残留 WA_PI_WS_PORT=9778，
  // 下方 killPort 会误杀生产进程（2026-08-23 事故）。kernel 子进程的实际端口
  // 仍由 runDev 内注入的 WA_PI_WS_PORT 传递，与 9778 无关。
  const DEV_WS_PORT = 9776;
  const { FRONTEND_PORT } = await import("@wa-pi/shared");
  await runDev(DEV_WS_PORT, FRONTEND_PORT);
}

async function runDev(WS_PORT: number, FRONTEND_PORT: number) {
  // pi rpc 子进程跟随当前 bun（重启后=下载 bun；正常时=自身）。resolvePiRuntime
  // 的优先级是 env > PATH > execPath，env 注入能覆盖 PATH 上的旧 bun。
  process.env.WA_PI_PI_RUNTIME = process.execPath;
  // 1. 端口清理(兜底,防止上次没干净) + 动态选择 kernel 端口
  console.log("[dev] 清理端口 %d / %d ...", WS_PORT, FRONTEND_PORT);
  await Promise.all([killPort(WS_PORT), killPort(FRONTEND_PORT)]);
  const actualWsPort = await findAvailablePort(WS_PORT);
  process.env.WA_PI_WS_PORT = String(actualWsPort);
  console.log("[dev] kernel 实际端口 %d", actualWsPort);

  // 2. 并行 spawn 两个子进程
  let kernel: ChildProcess = spawnKernel();
  let frontend: ChildProcess = spawnFrontend();

  let lastOpenedFrontendPort: number | null = null;
  let actualFrontendPort = FRONTEND_PORT; // Vite 可能因端口占用自动换端口

  function bindFrontendEvents(proc: ChildProcess) {
    proc.stdout!.on("data", (d: Buffer) => {
      const line = d.toString();
      process.stdout.write(`[web] ${line}`);
      const m = line.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (!m) return;
      actualFrontendPort = Number(m[1]);
      // 端口变化时重新打开浏览器（首次启动或按 R 重启后 Vite 换端口）
      if (lastOpenedFrontendPort !== actualFrontendPort) {
        if (lastOpenedFrontendPort != null) {
          console.log(
            "[dev] ⚠ Vite 换端口 %d → %d",
            lastOpenedFrontendPort,
            actualFrontendPort,
          );
        } else if (actualFrontendPort !== FRONTEND_PORT) {
          console.log(
            "[dev] ⚠ Vite 换端口 %d → %d",
            FRONTEND_PORT,
            actualFrontendPort,
          );
        }
        const url = `http://localhost:${actualFrontendPort}`;
        console.log("[dev] ▶ 打开浏览器 %s", url);
        openBrowser(url);
        lastOpenedFrontendPort = actualFrontendPort;
      }
    });
    proc.stderr!.on("data", (d: Buffer) =>
      process.stderr.write(`[web] ${d.toString()}`),
    );
  }

  function bindKernelEvents(proc: ChildProcess) {
    proc.stdout!.on("data", (d: Buffer) =>
      process.stdout.write(`[kernel] ${d.toString()}`),
    );
    proc.stderr!.on("data", (d: Buffer) =>
      process.stderr.write(`[kernel] ${d.toString()}`),
    );
  }

  bindKernelEvents(kernel);
  bindFrontendEvents(frontend);

  // 首次启动兜底：stdout 正则路径（见 bindFrontendEvents）在输出丢失时不会开浏览器，
  // 主动探测就绪后补开（lastOpenedFrontendPort 已设说明正则已开过，跳过，不重复开）。
  // 探测失败（vite 未就绪）也要打印，避免输出丢失时无声卡死无任何线索。
  void (async () => {
    const ok = await waitFrontendReady(FRONTEND_PORT, { timeoutMs: 60_000 });
    if (ok) {
      if (lastOpenedFrontendPort == null) {
        const url = `http://localhost:${FRONTEND_PORT}`;
        console.log("[dev] ▶ 打开浏览器 %s", url);
        openBrowser(url);
        lastOpenedFrontendPort = FRONTEND_PORT;
      }
    } else {
      console.log(
        "[dev] ⚠ 首次启动 60s 内未探测到前端(http://localhost:%d)，请查看上方 [web] 错误输出排查",
        FRONTEND_PORT,
      );
    }
  })();

  // 3. 统一 SIGINT/SIGTERM 清理
  const cleanup = async () => {
    console.log("\n[dev] 退出,清理子进程...");
    await Promise.all([stopProc(kernel), stopProc(frontend)]);
    await Promise.all([killPort(WS_PORT), killPort(FRONTEND_PORT)]);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 4. 按 R 重新加载前后端代码（kill 两个子进程并重新 spawn）
  // reloading 防重入：重载要经历杀树→清端口→spawn→等前端就绪（可达数十秒），
  // 期间再按 R 会并发跑第二个 reloadAll，与第一个互相杀对方刚 spawn 的进程树、
  // 抢占同一端口（2026-09-01 实测复现：两条"重新加载"交叠输出）。故重载进行中忽略后续按 R。
  let reloading = false;

  // 等待前端 dev server 就绪并给出确定性反馈。
  // 不依赖 [web] 的 stdout：bun run --filter 的输出转发偶发丢输出（2026-09-01 现场
  // 取证：vite 正常监听服务但终端零 [web] 输出），靠 stdout 正则判断就绪会漏反馈。
  async function reportFrontendReady(scene: string): Promise<boolean> {
    let lastLog = 0;
    const ready = await waitFrontendReady(FRONTEND_PORT, {
      timeoutMs: 60_000,
      onPoll(elapsedMs) {
        if (elapsedMs - lastLog >= 10_000) {
          lastLog = elapsedMs;
          console.log(
            "[dev] 仍在等待前端启动... (%ds)",
            Math.round(elapsedMs / 1000),
          );
        }
      },
    });
    if (ready) {
      console.log(
        "[dev] ✓ 前端已就绪 http://localhost:%d （%s完成，浏览器未自动刷新时手动刷新即可）",
        FRONTEND_PORT,
        scene,
      );
    } else {
      console.log(
        "[dev] ⚠ 等待前端就绪超时(60s)，请查看上方 [web] 错误输出排查",
      );
    }
    return ready;
  }

  async function reloadAll() {
    console.log("\n[dev] 重新加载前后端代码...");
    reloading = true;
    try {
      await Promise.all([stopProc(kernel), stopProc(frontend)]);
      await killPort(WS_PORT);
      const actualWsPort = await findAvailablePort(WS_PORT);
      process.env.WA_PI_WS_PORT = String(actualWsPort);
      console.log("[dev] kernel 实际端口 %d", actualWsPort);
      await killPort(FRONTEND_PORT);

      kernel = spawnKernel();
      frontend = spawnFrontend();
      bindKernelEvents(kernel);
      bindFrontendEvents(frontend);
      await reportFrontendReady("重载");
    } finally {
      reloading = false;
    }
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", async (key: string) => {
      if (key === "r" || key === "R") {
        if (reloading) {
          console.log("[dev] 重载进行中，本次按 R 已忽略（完成后可再按）");
        } else {
          await reloadAll();
        }
      } else if (key === "" || key === "") {
        // Ctrl+C / Ctrl+D
        await cleanup();
      }
    });
  }
}

interface ProcSpec {
  label: string;
  cmd: [string, string[]];
}

const isWindows = process.platform === "win32";

/**
 * 终止 spawn 出的子进程及其整棵进程树。
 * spawn 用了 shell:true,直接 kill 只会杀掉外层 cmd.exe/sh,
 * 真正占端口的孙进程(bun.exe/node.exe)会成为孤儿继续监听 → 下次 reload EADDRINUSE。
 * 故 Windows 用 taskkill /T /F 杀整棵树;POSIX 用递归 shell 函数杀整棵树。
 */
async function stopProc(p: ChildProcess): Promise<void> {
  if (p.pid == null) return;
  try {
    if (isWindows) {
      await runCmd("taskkill", ["/PID", String(p.pid), "/T", "/F"]);
    } else {
      // POSIX: spawn 用了 shell:true，p.kill('SIGTERM') 只杀 shell，
      // 其子进程(bun/vite)成为孤儿继续占用端口，导致下次 reload EADDRINUSE。
      // 用递归函数杀整棵进程树，与 Windows taskkill /T /F 行为对称。
      await runCmd("/bin/sh", [
        "-c",
        `k() { for c in $(pgrep -P $1 2>/dev/null); do k $c; done; kill -9 $1 2>/dev/null; }; k ${p.pid}`,
      ]);
    }
  } catch {
    // 清理失败静默忽略：进程可能已退出/权限不足，不阻塞退出流程。
  }
}

/** spawn 一个命令并等其退出(用于清理,忽略输出与失败) */
function runCmd(bin: string, args: string[]): Promise<void> {
  const child = spawn(bin, args, { stdio: "ignore" });
  return new Promise((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function spawnProcs(spec: ProcSpec) {
  const [bin, args] = spec.cmd;
  // 用绝对路径 exe（process.execPath，重启后即下载的 bun）直接 spawn，无需 shell
  // 解析 PATHEXT；shell:false 避免路径含空格被 cmd 误拆（数组参数自动正确转义）。
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
}

function spawnKernel() {
  return spawnProcs({
    label: "kernel",
    cmd: [process.execPath, ["run", "--filter", "@wa-pi/kernel", "dev"]],
  });
}

function spawnFrontend() {
  return spawnProcs({
    label: "web",
    // --bun：强制 vite 用 bun runtime 执行。vite bin 脚本 shebang 为
    // #!/usr/bin/env node，默认会解析到系统 node（本机 v14 过旧，不支持
    // vite 8 的 ??= 等语法）；--bun 会把 node 符号链接指向 bun，vite 在
    // bun runtime 下正常启动（与 Node ≥20 要求解耦）。
    cmd: [
      process.execPath,
      ["--bun", "run", "--filter", "@wa-pi/frontend", "dev"],
    ],
  });
}

main().catch((e) => {
  console.error("[dev] 启动失败:", e);
  process.exit(1);
});
