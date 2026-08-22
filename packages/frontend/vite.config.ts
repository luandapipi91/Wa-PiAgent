import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

// 应用版本号：构建时从 package.json 读取，注入 import.meta.env.WA_PI_VERSION。
// 浏览器 bundle 无 Electron 的 app.getVersion()，靠此让「关于」页显示版本号。
let appVersion = "0.0.0";
try {
  appVersion = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./package.json", import.meta.url)),
      "utf8",
    ),
  ).version;
} catch {
  // package.json 缺失/损坏时回退，构建仍可继续（版本仅展示用）
}

/**
 * 决定某个 key 注入前端 bundle 的值（import.meta.env.WA_PI_DIR 等）。
 * 独立纯函数便于单测（vite.config 的 define 注入是打包版「前端查错目录」bug 的根因）。
 */
export function resolveInjectedValue(
  key: string,
  mode: string,
  processEnv: Record<string, string | undefined>,
  envVars: Record<string, string | undefined>,
): string | undefined {
  // 生产构建（打包版）绝不注入机器相关路径（WA_PI_DIR / HOME / USERPROFILE）：
  // 1) WA_PI_DIR：bun run 会自动加载根目录 .env（dev 隔离目录 ~/.pi/agent-dev）到 process.env，
  //    无法与显式 env 区分；打包版 kernel 数据目录由运行时决定（默认 ~/.pi/agent）。
  // 2) HOME / USERPROFILE：打包机家目录一旦进 bundle，非构建机上前端 constants.ts 用
  //    `${HOME}/.pi/agent` 回退拼出的默认工作区就是错的本机路径（如 Windows 上请求
  //    /Users/pipi/.pi/agent/workdir/... → listDir 返回 fs:error → 文件树空白）。
  // 前端默认工作区路径应使用 kernel 持久化的 __system__.cwd（/api/projects 返回的运行时
  // 本机路径），故机器相关路径一律不注入；WA_PI_WS_PORT 走 resolveWsPortDefine，同样不读打包机 env。
  if (
    mode === "production" &&
    (key === "WA_PI_DIR" || key === "HOME" || key === "USERPROFILE")
  ) {
    return undefined;
  }
  if (mode === "production") return processEnv[key];
  return processEnv[key] ?? envVars[key];
}

/**
 * 决定注入 bundle 的 WA_PI_WS_PORT。
 * production（打包版）恒用默认 9776：打包机的 process.env / .env 是 dev 配置，
 * 打进 bundle 会让安装版前端连错端口；dev 模式才读 env（E2E 隔离端口用）。
 */
export function resolveWsPortDefine(
  mode: string,
  processEnv: Record<string, string | undefined>,
  envVars: Record<string, string | undefined>,
): string {
  if (mode === "production") return "9776";
  return processEnv.WA_PI_WS_PORT ?? envVars.WA_PI_WS_PORT ?? "9776";
}

export default defineConfig(({ mode }) => {
  const envVars = loadEnv(mode, process.cwd(), ""); // 读 .env（含非 VITE_ 前缀）
  const webPort = Number(envVars.WA_PI_WEB_PORT) || 5180;
  // 把进程 env 注入前端 bundle：shared/constants.ts 双源读 process.env 和 import.meta.env。
  // 浏览器 bundle 里 process 是 undefined，靠 vite define 把 import.meta.env.WA_PI_DIR 等
  // 静态替换为构建时字面量。E2E 用 WA_PI_DIR 隔离测试目录；不注入则前端回退用户真实 ~/.wa-pi。
  // WA_PI_WS_PORT 同理注入，让浏览器 bundle 的 WS_PORT 指向 .env 配置的后端端口；
  // production 取值规则见 resolveWsPortDefine（恒 9776，不读打包机 env）。
  const defineEntries: Record<string, string> = {
    "import.meta.env.WA_PI_WS_PORT": JSON.stringify(
      resolveWsPortDefine(mode, process.env, envVars),
    ),
    "import.meta.env.WA_PI_VERSION": JSON.stringify(appVersion),
  };
  for (const key of ["WA_PI_DIR", "HOME", "USERPROFILE"]) {
    const val = resolveInjectedValue(key, mode, process.env, envVars);
    if (val !== undefined)
      defineEntries[`import.meta.env.${key}`] = JSON.stringify(val);
  }

  const wsPort =
    Number(process.env.WA_PI_WS_PORT) || Number(envVars.WA_PI_WS_PORT) || 9776;

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
        "/preview": {
          target: `http://127.0.0.1:${wsPort}`,
          changeOrigin: true,
        },
      },
    },
    define: defineEntries,
    resolve: {
      alias: {
        "@wa-pi/shared": fileURLToPath(
          new URL("../shared/src/index.ts", import.meta.url),
        ),
      },
    },
  };
});
