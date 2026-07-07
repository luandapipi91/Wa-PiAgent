import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    exclude: ["node_modules/**", "e2e/**", "playwright.config.ts"],
    // happy-dom 缺原生 WebSocket，给组件测试 polyfill（ws-instance 的真实 getWs 会 new WebSocket）
    // E2E 用真实浏览器有自己的 WebSocket，此 setup 只影响 vitest
    setupFiles: ["./tests/setup-websocket.ts"],
  },
  resolve: {
    alias: { "@hiagent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
});
