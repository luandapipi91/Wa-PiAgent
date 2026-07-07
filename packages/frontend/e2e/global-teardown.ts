// E2E globalTeardown：杀 kernel 进程，清理隔离目录
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_HIAGENT_DIR } from "../playwright.config";

async function globalTeardown() {
  // 读 globalSetup 写的 pid 杀 kernel
  try {
    const pid = parseInt(readFileSync(join(E2E_HIAGENT_DIR, ".kernel-pid"), "utf8"), 10);
    if (pid) {
      // globalSetup 用 shell:true 启动，Windows 下 child.pid 是 cmd.exe 的 pid，
      // 需要用 taskkill /T 杀整个进程树（含 bun 子进程），否则 SIGTERM 只杀 cmd.exe，
      // 真正的 kernel 进程会成为孤儿继续占用 9776 端口
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {}

  // 清理隔离目录（含 projects.json + sessions + .kernel-pid）
  rmSync(E2E_HIAGENT_DIR, { recursive: true, force: true });
}

export default globalTeardown;
