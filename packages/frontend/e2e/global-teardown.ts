// E2E globalTeardown：杀 kernel 进程，清理隔离目录
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";

async function globalTeardown() {
  // 读 globalSetup 写的 pid 杀 kernel
  try {
    const pid = parseInt(readFileSync(join(E2E_WA_PI_DIR, ".kernel-pid"), "utf8"), 10);
    if (pid) {
      // globalSetup 用 shell:true 启动，Windows 下 child.pid 是 cmd.exe 的 pid，
      // 需要用 taskkill /T 杀整个进程树（含 bun 子进程），否则 SIGTERM 只杀 cmd.exe，
      // 真正的 kernel 进程会成为孤儿继续占用 9776 端口
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        // POSIX：配合 globalSetup 的 detached:true，负 pid 杀整个进程组（sh + bun kernel），
        // 避免只杀 shell 导致 kernel 成孤儿占用 9776（组杀失败回退单杀）
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          process.kill(pid, "SIGTERM");
        }
      }
    }
  } catch {}

  // RPC 架构下 kernel 派生的 pi 子进程在 stdin（管道）断开后自行退出，但有几秒延迟；
  // 立即 rm 会撞上 EBUSY（Windows 文件锁）。等待并重试，最终清不掉也不致命（目录在 %HOME%）。
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      rmSync(E2E_WA_PI_DIR, { recursive: true, force: true });
      return;
    } catch {
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export default globalTeardown;
