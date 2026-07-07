import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(() => {
  // 把进程 env 注入前端 bundle：shared/constants.ts 双源读 process.env 和 import.meta.env。
  // 浏览器 bundle 里 process 是 undefined，靠 vite define 把 import.meta.env.HIAGENT_DIR 等
  // 静态替换为构建时字面量。E2E 用 HIAGENT_DIR 隔离测试目录；不注入则前端回退用户真实 ~/.hiagent。
  const defineEntries: Record<string, string> = {};
  for (const key of ['HIAGENT_DIR', 'HOME', 'USERPROFILE']) {
    const val = process.env[key];
    if (val !== undefined) defineEntries[`import.meta.env.${key}`] = JSON.stringify(val);
  }

  return {
    plugins: [react()],
    server: { port: 5173 },
    define: defineEntries,
    resolve: {
      alias: { "@hiagent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
    },
  };
});
