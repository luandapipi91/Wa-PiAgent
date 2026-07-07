import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  // 把进程 env 注入前端 bundle：shared/constants.ts 双源读 process.env 和 import.meta.env。
  // 浏览器 bundle 里 process 是 undefined，所以必须用 define 静态替换 + import.meta.env 兜底。
  // E2E 用 HIAGENT_DIR 隔离测试目录；不注入则前端回退用户真实 ~/.hiagent，E2E 隔离失效。
  const envVars = ['HIAGENT_DIR', 'HOME', 'USERPROFILE'];
  const defineEntries: Record<string, string> = {};
  for (const key of envVars) {
    const val = process.env[key];
    if (val !== undefined) {
      // 注入 import.meta.env（constants.ts 浏览器分支读这个）
      defineEntries[`__HIAGENT_ENV_${key}__`] = JSON.stringify(val);
    }
  }

  return {
    plugins: [
      react(),
      {
        name: 'hiagent-env-inject',
        // 在 transformIndexHtml 之前，把常量定义到 import.meta.env
        // 实际用 define 更可靠：直接替换 import.meta.env.HIAGENT_DIR 表达式
      },
    ],
    server: { port: 5173 },
    define: {
      // 直接替换 import.meta.env.HIAGENT_DIR 等为构建时字面量
      ...(process.env.HIAGENT_DIR ? { 'import.meta.env.HIAGENT_DIR': JSON.stringify(process.env.HIAGENT_DIR) } : {}),
      ...(process.env.HOME ? { 'import.meta.env.HOME': JSON.stringify(process.env.HOME) } : {}),
      ...(process.env.USERPROFILE ? { 'import.meta.env.USERPROFILE': JSON.stringify(process.env.USERPROFILE) } : {}),
    },
    resolve: {
      alias: { "@hiagent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
    },
  };
});
