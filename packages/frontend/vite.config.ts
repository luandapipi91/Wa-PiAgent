import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

// 应用版本号：构建时从 package.json 读取，注入 import.meta.env.WA_PI_VERSION。
// 浏览器 bundle 无 Electron 的 app.getVersion()，靠此让「关于」页显示版本号。
const appVersion = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")).version;

export default defineConfig(({ mode }) => {
  const envVars = loadEnv(mode, process.cwd(), "");          // 读 .env（含非 VITE_ 前缀）
  const webPort = Number(envVars.WA_PI_WEB_PORT) || 5180;
  // 把进程 env 注入前端 bundle：shared/constants.ts 双源读 process.env 和 import.meta.env。
  // 浏览器 bundle 里 process 是 undefined，靠 vite define 把 import.meta.env.WA_PI_DIR 等
  // 静态替换为构建时字面量。E2E 用 WA_PI_DIR 隔离测试目录；不注入则前端回退用户真实 ~/.wa-pi。
  // WA_PI_WS_PORT 同理注入，让浏览器 bundle 的 WS_PORT 指向 .env 配置的后端端口。
  const defineEntries: Record<string, string> = {
    "import.meta.env.WA_PI_WS_PORT": JSON.stringify(process.env.WA_PI_WS_PORT ?? envVars.WA_PI_WS_PORT ?? "9776"),
    "import.meta.env.WA_PI_VERSION": JSON.stringify(appVersion),
  };
  for (const key of ["WA_PI_DIR", "HOME", "USERPROFILE"]) {
    const val = process.env[key] ?? envVars[key];
    if (val !== undefined) defineEntries[`import.meta.env.${key}`] = JSON.stringify(val);
  }

  const wsPort = Number(process.env.WA_PI_WS_PORT) || Number(envVars.WA_PI_WS_PORT) || 9776;

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
      alias: { "@wa-pi/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
    },
  };
});
