import { defineConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// E2E 隔离目录：独立的 WA_PI_DIR，避免污染用户真实数据。
// 目录必须确定性：Playwright 的 globalSetup 进程与每个 worker 进程各自加载一次本 config，
// 若用 randomUUID() 则各进程拿到不同目录（session-history 曾因此 ENOENT projects.json）。
// 固定为 ~/.wa-pi-e2e，由 globalSetup 开头清空重建、globalTeardown 整体删除；
// 也可用 WA_PI_E2E_DIR 环境变量覆盖（多实例并行时）。
export const E2E_WA_PI_DIR =
  process.env.WA_PI_E2E_DIR ||
  join(process.env.HOME || process.env.USERPROFILE || ".", ".wa-pi-e2e");
mkdirSync(E2E_WA_PI_DIR, { recursive: true });

// E2E kernel WS 端口：本机已跑着真实 kernel（9776）时用 WA_PI_E2E_WS_PORT 偏移，
// 避免 globalSetup 误连真实 kernel、测试污染真实数据。默认 9776 与既有行为一致。
// vite.config.ts 已将 WA_PI_WS_PORT 注入前端 bundle（WS_PORT）与 /file 代理，全链路同步偏移。
export const E2E_WS_PORT = Number(process.env.WA_PI_E2E_WS_PORT) || 9776;

export default defineConfig({
  testDir: "./e2e",
  // 单 worker：全部 spec 共享同一隔离 kernel，session:created 等 SSE 广播会让并行 worker 的
  // 页面互相干扰（addSession 自动选中他人会话、provider 卡片计数串台），必须串行跑
  workers: 1,
  use: { baseURL: "http://localhost:5180", headless: true },
  // globalSetup 启动隔离 kernel（独立 WA_PI_DIR），globalTeardown 清理
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5180",
    reuseExistingServer: !process.env.CI,
    env: { WA_PI_DIR: E2E_WA_PI_DIR, WA_PI_WS_PORT: String(E2E_WS_PORT) },
  },
});
