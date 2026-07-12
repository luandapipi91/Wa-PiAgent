// launcher（编译为 exe）：托盘 + spawn 解释运行的 kernel 子进程 + 开浏览器。
// 本进程 **不** import @hiagent/kernel / pi-coding-agent SDK → bun build --compile 可干净打包。
// kernel 由子进程 `bun run kernel.js` 解释执行，node_modules 在磁盘上 → SDK 动态加载正常。
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { WS_PORT } from "@hiagent/shared";
import { createLogger } from "./log";
import { isPortInUse } from "./util/port";
import { openBrowser } from "./util/open-browser";
import { extractAssets } from "./embed";
import { startTray, type TrayHandle } from "./systray-setup";
import { EMBEDDED_ASSETS } from "./embedded-assets"; // build 时生成

const HIAGENT_DIR = process.env.HIAGENT_DIR || join(homedir(), ".hiagent");
const CACHE_DIR = join(HIAGENT_DIR, ".cache");
const log = createLogger(join(HIAGENT_DIR, "logs", "desktop.log"));

// exe 同级目录布局（P2 folder-assembly 产出）：
//   HiAgent.exe / bun.exe / kernel.js / node_modules/ / web/
// 允许 env 覆盖以便开发/测试。
const exeDir = dirname(process.execPath);
const bunBin =
  process.env.HIAGENT_BUN_BIN ||
  join(exeDir, process.platform === "win32" ? "bun.exe" : "bun");
const kernelJs = process.env.HIAGENT_KERNEL_JS || join(exeDir, "kernel.js");
const webDir = process.env.HIAGENT_WEB_DIR || join(exeDir, "web");

function iconPath(): string {
  const f =
    process.platform === "win32"
      ? "tray_windows.ico"
      : process.platform === "darwin"
        ? "tray_darwin.png"
        : "tray_linux.png";
  return join(CACHE_DIR, "icons", f);
}

/** 轮询端口直到 kernel 监听或超时。 */
async function waitForKernel(
  port: number,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** 跨平台 kill 子进程树：Windows taskkill /T /F，POSIX SIGTERM。best-effort。 */
function killChildTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // best-effort
  }
}

function pipeChildStdio(child: ChildProcess): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) log.info(`[kernel] ${line}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) log.error(`[kernel] ${line}`);
    }
  });
}

async function main() {
  log.info(`启动 desktop (launcher), platform=${process.platform}`);
  log.info(
    `exeDir=${exeDir} bunBin=${bunBin} kernelJs=${kernelJs} webDir=${webDir}`,
  );

  // 廉价单实例：端口被占即视为已有实例运行，打开浏览器后退出。
  if (await isPortInUse(WS_PORT)) {
    log.info("检测到已有实例，打开浏览器后退出");
    await openBrowser(`http://127.0.0.1:${WS_PORT}`);
    process.exit(0);
  }

  // 端口空闲 → 解压嵌入资源（托盘图标 + systray helper，launcher 自用）→ chdir → spawn kernel
  await extractAssets(EMBEDDED_ASSETS, CACHE_DIR);
  process.chdir(CACHE_DIR); // 让 systray2 的 ./traybin/<bin> 解析命中

  // spawn kernel 子进程（bun 解释运行 kernel.js，cwd=exeDir 让 kernel.js 解析同级 node_modules）
  const child = spawn(bunBin, ["run", kernelJs], {
    cwd: exeDir,
    env: { ...process.env, HIAGENT_WEB_DIR: webDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  log.info(`kernel 子进程 pid=${child.pid}`);
  pipeChildStdio(child);

  // 子进程意外退出时记录
  child.on("exit", (code, signal) => {
    log.info(`kernel 子进程退出 code=${code} signal=${signal}`);
  });

  // 等 kernel 就绪
  const ready = await waitForKernel(WS_PORT);
  if (ready) {
    log.info(`kernel 就绪，伺服 http://127.0.0.1:${WS_PORT}`);
  } else {
    log.error("kernel 30s 内未就绪，继续起托盘但可能不可用");
  }

  await openBrowser(`http://127.0.0.1:${WS_PORT}`);

  const tray = await startTray({
    iconPath: iconPath(),
    onOpen: () => {
      openBrowser(`http://127.0.0.1:${WS_PORT}`).catch(() => {});
    },
    onQuit: () => {
      cleanup(child, tray).catch(() => process.exit(0));
    },
  });

  const onSignal = () => cleanup(child, tray).catch(() => process.exit(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function cleanup(child: ChildProcess, tray: TrayHandle): Promise<void> {
  log.info("退出清理");
  killChildTree(child);
  try {
    await tray.kill();
  } catch (e) {
    log.error("tray.kill 失败", e);
  }
  try {
    await log.flush();
  } catch {
    // best-effort
  }
  process.exit(0);
}

main().catch((e) => {
  log.error("启动失败", e);
  process.exit(1);
});
