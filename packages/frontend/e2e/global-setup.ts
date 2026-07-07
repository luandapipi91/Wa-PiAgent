// E2E globalSetup：启动隔离 kernel（端口 9776），把进程 pid 存到全局供 teardown 清理
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_HIAGENT_DIR } from "../playwright.config";

async function globalSetup() {
  // 启动 kernel，注入独立 HIAGENT_DIR（覆盖 ~/.hiagent）
  const child = spawn("bun", ["run", "--filter", "@hiagent/kernel", "dev"], {
    env: { ...process.env, HIAGENT_DIR: E2E_HIAGENT_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});  // 防 stdout 缓冲写满阻塞
  child.stderr?.on("data", () => {});

  // 等 kernel 起来（轮询 9776 端口）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ok = await checkPort(9776);
    if (ok) {
      writeFileSync(join(E2E_HIAGENT_DIR, ".kernel-pid"), String(child.pid));
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  child.kill();
  throw new Error("E2E kernel 启动超时（端口 9776 未监听）");
}

function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
    setTimeout(() => { ws.close(); resolve(false); }, 200);
  });
}

export default globalSetup;
