// kernel 唯一启动入口：dev:kernel / dev:desktop / 打包三条链都走这里（→ startKernel）。
// 运行形态：dev:kernel 解释运行（bun run）；dev:desktop 与打包为 bun --compile 编译产物。
// staticDir 来自 launcher 注入的 WA_PI_WEB_DIR；端口来自 WA_PI_WS_PORT（缺省 9778）。
import { startKernel } from "./index";

const webDir = process.env.WA_PI_WEB_DIR;
const port = Number(process.env.WA_PI_WS_PORT) > 0 ? Number(process.env.WA_PI_WS_PORT) : undefined;
startKernel(webDir ? { staticDir: webDir, port } : { port })
  .then(({ port }) => console.log(`[kernel] 桌面 server 监听 http://127.0.0.1:${port}`))
  .catch((e) => {
    console.error("[kernel] 启动失败:", e);
    process.exit(1);
  });
