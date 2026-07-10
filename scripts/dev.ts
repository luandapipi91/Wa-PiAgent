// 一键启动:并行起 kernel(9776 WS)+ frontend(Vite 5180),自动开浏览器,SIGINT 清理,按 R 重载前后端。
import { spawn, type ChildProcess } from "node:child_process";
import { killPort } from "./port";
import { openBrowser } from "./open-browser";

const KERNEL_WS_PORT = 9776;
const FRONTEND_PORT = 5180;

async function main() {
  // 1. 端口清理(兜底,防止上次没干净)
  console.log("[dev] 清理端口 %d / %d ...", KERNEL_WS_PORT, FRONTEND_PORT);
  await Promise.all([killPort(KERNEL_WS_PORT), killPort(FRONTEND_PORT)]);

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
    for (const p of [kernel, frontend]) {
      try { process.kill(p.pid!, "SIGTERM"); } catch {}
    }
    await Promise.all([killPort(KERNEL_WS_PORT), killPort(FRONTEND_PORT)]);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 4. 按 R 重新加载前后端代码（kill 两个子进程并重新 spawn）
  async function reloadAll() {
    console.log("\n[dev] 重新加载前后端代码...");
    for (const p of [kernel, frontend]) {
      try { p.kill("SIGTERM"); } catch {}
    }
    await Promise.all([killPort(KERNEL_WS_PORT), killPort(FRONTEND_PORT)]);

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
