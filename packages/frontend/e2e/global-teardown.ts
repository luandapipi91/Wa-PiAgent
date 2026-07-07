// E2E globalTeardown：杀 kernel 进程，清理隔离目录
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_HIAGENT_DIR } from "../playwright.config";

async function globalTeardown() {
  // 读 globalSetup 写的 pid 杀 kernel
  try {
    const pid = parseInt(readFileSync(join(E2E_HIAGENT_DIR, ".kernel-pid"), "utf8"), 10);
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}

  // 清理隔离目录（含 projects.json + sessions + .kernel-pid）
  rmSync(E2E_HIAGENT_DIR, { recursive: true, force: true });
}

export default globalTeardown;
