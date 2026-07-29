import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// E2E 隔离目录：每个测试运行用独立的 WA_PI_DIR，避免污染用户真实数据
export const E2E_WA_PI_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  `.wa-pi-e2e-${randomUUID().slice(0, 8)}`,
);
mkdirSync(E2E_WA_PI_DIR, { recursive: true });

// E2E kernel WS 端口：本机已跑着真实 kernel（9776）时用 WA_PI_E2E_WS_PORT 偏移，
// 避免 globalSetup 误连真实 kernel、测试污染真实数据。默认 9776 与既有行为一致。
// vite.config.ts 已将 WA_PI_WS_PORT 注入前端 bundle（WS_PORT）与 /file 代理，全链路同步偏移。
export const E2E_WS_PORT = Number(process.env.WA_PI_E2E_WS_PORT) || 9776;

export default defineConfig({
  testDir: "./e2e",
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
