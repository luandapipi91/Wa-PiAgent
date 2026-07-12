// 端口占用检测（搬自 scripts/port.ts，desktop 专用副本）。
// 注：killPort 已删除——单实例逻辑改为 isPortInUse 检测 + 直接退出，
// 不再需要杀端口能力。
import { createServer } from "node:net";

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port);
  });
}
