// 本地临时 config（不进 git）：本机 5180/9776 已被日常 dev 实例占用时，
// 用独立端口跑 E2E——web 5181 + WS 19876（HIAGENT_E2E_WS_PORT 控制），
// 完全复用 playwright.config.ts 的 global-setup/teardown 与隔离 HIAGENT_DIR。
// 用法：HIAGENT_E2E_WS_PORT=19876 bunx playwright test -c playwright.local.config.ts e2e/chat-blocks.spec.ts
import base from "./playwright.config";

const WEB_PORT = Number(process.env.HIAGENT_E2E_WEB_PORT) || 5181;
const baseWebServer = (base as any).webServer ?? {};

export default {
  ...base,
  use: { ...(base as any).use, baseURL: `http://localhost:${WEB_PORT}` },
  webServer: {
    ...baseWebServer,
    // vite.config.ts 的 webPort 只从 .env 读、strictPort 5180 必撞车；
    // CLI --port 覆盖 config 端口，WS_PORT 仍经 env 注入（vite.config 从 process.env 读）。
    command: `bunx vite --port ${WEB_PORT} --strictPort`,
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: false,
  },
};
