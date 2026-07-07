import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// E2E 隔离目录：每个测试运行用独立的 HIAGENT_DIR，避免污染用户真实数据
export const E2E_HIAGENT_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  `.hiagent-e2e-${randomUUID().slice(0, 8)}`,
);
mkdirSync(E2E_HIAGENT_DIR, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:5180", headless: true },
  // globalSetup 启动隔离 kernel（独立 HIAGENT_DIR），globalTeardown 清理
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5180",
    reuseExistingServer: !process.env.CI,
    env: { HIAGENT_DIR: E2E_HIAGENT_DIR },
  },
});
