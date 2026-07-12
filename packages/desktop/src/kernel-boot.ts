// 在本进程起 kernel（WS + 静态前端，同 9776）。
// startKernel 已返回 { port, stop }；原样透传 stop 以支持优雅退出（见 main.ts cleanup）。
import { startKernel } from "@hiagent/kernel";
import { WS_PORT } from "@hiagent/shared";

export async function bootKernel(
  staticDir: string,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const kernel = await startKernel({ staticDir });
  if (kernel.port !== WS_PORT) throw new Error(`kernel 端口异常: ${kernel.port}`);
  return kernel;
}
