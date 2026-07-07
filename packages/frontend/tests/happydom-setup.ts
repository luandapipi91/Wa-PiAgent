// bun:test 的 DOM 测试 preload:注册 happy-dom 全局 + WebSocket polyfill。
// vitest 时代靠 vitest.config.ts 的 environment+setupFiles;迁 bun:test 后改用 preload。
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import "./setup-websocket";  // 复用现有 WebSocket polyfill(setup-websocket.ts 内容不变)
GlobalRegistrator.register();
