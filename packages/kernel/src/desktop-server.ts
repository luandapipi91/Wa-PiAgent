// 桌面分发专用 kernel 入口：由 launcher 用 bun 解释运行（node_modules 在磁盘 → SDK 动态加载正常）。
// staticDir 来自 launcher 注入的 WA_PI_WEB_DIR（指向 folder/web）。
import { startKernel } from "./index";

const webDir = process.env.WA_PI_WEB_DIR;
const port = Number(process.env.WA_PI_WS_PORT) > 0 ? Number(process.env.WA_PI_WS_PORT) : undefined;
startKernel(webDir ? { staticDir: webDir, port } : { port })
  .then(({ port }) => console.log(`[kernel] 桌面 server 监听 http://127.0.0.1:${port}`))
  .catch((e) => {
    console.error("[kernel] 启动失败:", e);
    process.exit(1);
  });
