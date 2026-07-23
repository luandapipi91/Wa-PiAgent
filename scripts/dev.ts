// 一键启动:并行起 kernel(9776 WS)+ frontend(Vite 5180),自动开浏览器,SIGINT 清理,按 R 重载前后端。
import { spawn, type ChildProcess } from "node:child_process";
import { killPort, findAvailablePort } from "./port";
import { openBrowser } from "./open-browser";
// @hiagent/shared 改为动态 import:静态 import 在 node_modules 缺失时会直接崩,
// 无法进入自修复流程。改为运行时检测 + 自动 bun install(见 ensureDeps)。

/**
 * 自修复:检测 @hiagent/shared 是否可解析,缺失则自动 bun install 后重启自身进程。
 * 必须重启 —— bun 在进程启动时缓存 node_modules 解析结果,同进程内即使 install
 * 重建了 workspace symlink,import 仍命中"找不到"缓存。HIAGENT_DEPS_REPAIRED 防死循环。
 */
async function ensureDeps(): Promise<void> {
  try {
    await import("@hiagent/shared");
    return; // 已就绪
  } catch {
    // 缺失,走修复
  }
  if (process.env.HIAGENT_DEPS_REPAIRED === "1") {
    console.error("[dev] 上次 bun install 后 @hiagent/shared 仍无法解析,请手动运行 `bun install` 排查");
    process.exit(1);
  }
  console.log("[dev] 依赖缺失(@hiagent/shared 无法解析),自动执行 bun install 修复...");
  const code = await runCmdInherit("bun", ["install"]);
  if (code !== 0) {
    console.error("[dev] bun install 失败(退出码 %d),请手动运行排查", code);
    process.exit(1);
  }
  console.log("[dev] 依赖已修复,重启启动脚本以加载新依赖...");
  process.env.HIAGENT_DEPS_REPAIRED = "1";
  await relaunchSelf();
}

/** 用新进程重新执行当前脚本,当前进程挂起等待子进程退出后镜像其退出码。 */
function relaunchSelf(): Promise<never> {
  const [exe, script, ...extra] = process.argv;
  const child = spawn(exe, [script, ...extra], { stdio: "inherit" });
  return new Promise<never>((resolve) => {
    child.on("close", (code) => { process.exit(code ?? 0); resolve(); });
    child.on("error", (e) => { console.error("[dev] 重启失败:", e); process.exit(1); });
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
  const { WS_PORT, FRONTEND_PORT } = await import("@hiagent/shared");
  await runDev(WS_PORT, FRONTEND_PORT);
}

async function runDev(WS_PORT: number, FRONTEND_PORT: number) {
  // 1. 端口清理(兜底,防止上次没干净) + 动态选择 kernel 端口
  console.log("[dev] 清理端口 %d / %d ...", WS_PORT, FRONTEND_PORT);
  await Promise.all([killPort(WS_PORT), killPort(FRONTEND_PORT)]);
  const actualWsPort = await findAvailablePort(WS_PORT);
  process.env.HIAGENT_WS_PORT = String(actualWsPort);
  console.log("[dev] kernel 实际端口 %d", actualWsPort);

  // 2. 并行 spawn 两个子进程
  let kernel: ChildProcess = spawnKernel();
  let frontend: ChildProcess = spawnFrontend();

  let lastOpenedFrontendPort: number | null = null;
  let actualFrontendPort = FRONTEND_PORT;  // Vite 可能因端口占用自动换端口

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
          console.log("[dev] ⚠ Vite 换端口 %d → %d", lastOpenedFrontendPort, actualFrontendPort);
        } else if (actualFrontendPort !== FRONTEND_PORT) {
          console.log("[dev] ⚠ Vite 换端口 %d → %d", FRONTEND_PORT, actualFrontendPort);
        }
        const url = `http://localhost:${actualFrontendPort}`;
        console.log("[dev] ▶ 打开浏览器 %s", url);
        openBrowser(url);
        lastOpenedFrontendPort = actualFrontendPort;
      }
    });
    proc.stderr!.on("data", (d: Buffer) => process.stderr.write(`[web] ${d.toString()}`));
  }

  function bindKernelEvents(proc: ChildProcess) {
    proc.stdout!.on("data", (d: Buffer) => process.stdout.write(`[kernel] ${d.toString()}`));
    proc.stderr!.on("data", (d: Buffer) => process.stderr.write(`[kernel] ${d.toString()}`));
  }

  bindKernelEvents(kernel);
  bindFrontendEvents(frontend);

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
  async function reloadAll() {
    console.log("\n[dev] 重新加载前后端代码...");
    await Promise.all([stopProc(kernel), stopProc(frontend)]);
    await killPort(WS_PORT);
    const actualWsPort = await findAvailablePort(WS_PORT);
    process.env.HIAGENT_WS_PORT = String(actualWsPort);
    console.log("[dev] kernel 实际端口 %d", actualWsPort);
    await killPort(FRONTEND_PORT);

    kernel = spawnKernel();
    frontend = spawnFrontend();
    bindKernelEvents(kernel);
    bindFrontendEvents(frontend);
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", async (key: string) => {
      if (key === "r" || key === "R") {
        await reloadAll();
      } else if (key === "" || key === "") { // Ctrl+C / Ctrl+D
        await cleanup();
      }
    });
  }
}

interface ProcSpec { label: string; cmd: [string, string[]]; }

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
      await runCmd("/bin/sh", ["-c",
        `k() { for c in $(pgrep -P $1 2>/dev/null); do k $c; done; kill -9 $1 2>/dev/null; }; k ${p.pid}`,
      ]);
    }
  } catch {}
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
  // Windows 下 spawn 默认不解析 PATHEXT,找不到 bun.cmd;加 shell:true 走 cmd 解析。
  // POSIX 不需要 shell,但加上无害(命令本身无 shell 元字符)。
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: true });
}

function spawnKernel() {
  return spawnProcs({
    label: "kernel",
    cmd: ["bun", ["run", "--filter", "@hiagent/kernel", "dev"]],
  });
}

function spawnFrontend() {
  return spawnProcs({
    label: "web",
    cmd: ["bun", ["run", "--filter", "@hiagent/frontend", "dev"]],
  });
}

main().catch((e) => { console.error("[dev] 启动失败:", e); process.exit(1); });
