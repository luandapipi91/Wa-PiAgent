// 一键启动:并行起 kernel(9776 WS)+ frontend(Vite 5180),自动开浏览器,SIGINT 清理。
import { spawn } from "node:child_process";
import { killPort } from "./port";
import { openBrowser } from "./open-browser";

const KERNEL_WS_PORT = 9776;
const FRONTEND_PORT = 5180;

async function main() {
  // 1. 端口清理(兜底,防止上次没干净)
  console.log("[dev] 清理端口 %d / %d ...", KERNEL_WS_PORT, FRONTEND_PORT);
  await Promise.all([killPort(KERNEL_WS_PORT), killPort(FRONTEND_PORT)]);

  // 2. 并行 spawn 两个子进程
  const kernel = spawnProcs({
    label: "kernel",
    cmd: ["bun", ["run", "--filter", "@hiagent/kernel", "dev"]],
  });
  const frontend = spawnProcs({
    label: "web",
    cmd: ["bun", ["run", "--filter", "@hiagent/frontend", "dev"]],
  });

  let browserOpened = false;
  let actualFrontendPort = FRONTEND_PORT;  // Vite 可能因端口占用自动换端口
  frontend.stdout.on("data", (d: Buffer) => {
    const line = d.toString();
    process.stdout.write(`[web] ${line}`);
    // Vite 就绪输出: "➜  Local:   http://localhost:5180/" 或 "http://localhost:5181/"
    const m = line.match(/Local:\s+http:\/\/localhost:(\d+)/);
    if (m) actualFrontendPort = Number(m[1]);
    if (!browserOpened && m) {
      browserOpened = true;
      const url = `http://localhost:${actualFrontendPort}`;
      if (actualFrontendPort !== FRONTEND_PORT) {
        console.log("[dev] ⚠ Vite 换端口 %d → %d", FRONTEND_PORT, actualFrontendPort);
      }
      console.log("[dev] ▶ 打开浏览器 %s", url);
      openBrowser(url);
    }
  });
  kernel.stdout.on("data", (d: Buffer) => process.stdout.write(`[kernel] ${d.toString()}`));
  // stderr 同样打前缀
  kernel.stderr.on("data", (d: Buffer) => process.stderr.write(`[kernel] ${d.toString()}`));
  frontend.stderr.on("data", (d: Buffer) => process.stderr.write(`[web] ${d.toString()}`));

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
}

interface ProcSpec { label: string; cmd: [string, string[]]; }

function spawnProcs(spec: ProcSpec) {
  const [bin, args] = spec.cmd;
  // Windows 下 spawn 默认不解析 PATHEXT,找不到 bun.cmd;加 shell:true 走 cmd 解析。
  // POSIX 不需要 shell,但加上无害(命令本身无 shell 元字符)。
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: true });
}

main().catch((e) => { console.error("[dev] 启动失败:", e); process.exit(1); });
