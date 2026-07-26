import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const envVars = loadEnv(mode, process.cwd(), "");          // 读 .env（含非 VITE_ 前缀）
  const webPort = Number(envVars.HIAGENT_WEB_PORT) || 5180;
  // 把进程 env 注入前端 bundle：shared/constants.ts 双源读 process.env 和 import.meta.env。
  // 浏览器 bundle 里 process 是 undefined，靠 vite define 把 import.meta.env.HIAGENT_DIR 等
  // 静态替换为构建时字面量。E2E 用 HIAGENT_DIR 隔离测试目录；不注入则前端回退用户真实 ~/.hiagent。
  // HIAGENT_WS_PORT 同理注入，让浏览器 bundle 的 WS_PORT 指向 .env 配置的后端端口。
  const defineEntries: Record<string, string> = {
    "import.meta.env.HIAGENT_WS_PORT": JSON.stringify(process.env.HIAGENT_WS_PORT ?? envVars.HIAGENT_WS_PORT ?? "9776"),
  };
  for (const key of ["HIAGENT_DIR", "HOME", "USERPROFILE"]) {
    const val = process.env[key] ?? envVars[key];
    if (val !== undefined) defineEntries[`import.meta.env.${key}`] = JSON.stringify(val);
  }

  const wsPort = Number(process.env.HIAGENT_WS_PORT) || Number(envVars.HIAGENT_WS_PORT) || 9776;

  return {
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: true,
      // 开发时 /file 由 kernel 服务，Vite 默认会回退到 index.html，导致 <audio>/<img> 拿不到真实文件
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${wsPort}`,
          changeOrigin: true,
        },
        "/file": {
          target: `http://127.0.0.1:${wsPort}`,
          changeOrigin: true,
        },
      },
    },
    define: defineEntries,
    resolve: {
      alias: { "@hiagent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
    },
  };
});
