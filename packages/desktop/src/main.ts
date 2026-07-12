// 单进程编排：检测端口（单实例）→ 解压嵌入资源 → 起 kernel → 跑托盘 → 开浏览器 → 生命周期清理。
import { join } from "node:path";
import { homedir } from "node:os";
import { WS_PORT } from "@hiagent/shared";
import { createLogger } from "./log";
import { isPortInUse } from "./util/port";
import { openBrowser } from "./util/open-browser";
import { extractAssets } from "./embed";
import { bootKernel } from "./kernel-boot";
import { startTray, type TrayHandle } from "./systray-setup";
import { EMBEDDED_ASSETS } from "./embedded-assets"; // build 时生成

const HIAGENT_DIR = process.env.HIAGENT_DIR || join(homedir(), ".hiagent");
const CACHE_DIR = join(HIAGENT_DIR, ".cache");
const log = createLogger(join(HIAGENT_DIR, "logs", "desktop.log"));

interface KernelHandle {
  stop(): Promise<void>;
}

function iconPath(): string {
  const f =
    process.platform === "win32"
      ? "tray_windows.ico"
      : process.platform === "darwin"
        ? "tray_darwin.png"
        : "tray_linux.png";
  return join(CACHE_DIR, "icons", f);
}

async function main() {
  log.info(`启动 desktop, platform=${process.platform}`);

  // 廉价单实例：必须先检测，否则 killPort 会把已有实例杀掉。
  // stale-orphan（端口被崩溃的非服务进程占住）场景 v1 best-effort 不处理。
  if (await isPortInUse(WS_PORT)) {
    log.info("检测到已有实例，打开浏览器后退出");
    await openBrowser(`http://127.0.0.1:${WS_PORT}`);
    process.exit(0);
  }

  // 端口空闲 → 解压资源 → 起 kernel → chdir → 托盘 → 开浏览器
  await extractAssets(EMBEDDED_ASSETS, CACHE_DIR);
  process.chdir(CACHE_DIR); // 让 systray2 的 ./traybin/<bin> 解析命中

  const kernel = await bootKernel(join(CACHE_DIR, "web"));
  log.info(`kernel 就绪，伺服 http://127.0.0.1:${WS_PORT}`);

  await openBrowser(`http://127.0.0.1:${WS_PORT}`);

  const tray = await startTray({
    iconPath: iconPath(),
    onOpen: () => {
      openBrowser(`http://127.0.0.1:${WS_PORT}`).catch(() => {});
    },
    onQuit: () => {
      cleanup(kernel, tray).catch(() => process.exit(0));
    },
  });

  const onSignal = () => cleanup(kernel, tray).catch(() => process.exit(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function cleanup(kernel: KernelHandle, tray: TrayHandle): Promise<void> {
  log.info("退出清理");
  // 优雅关停：kernel.stop() 自带 server 关闭；不再对自启端口用 killPort 兜底。
  try {
    await kernel.stop();
  } catch (e) {
    log.error("kernel.stop 失败", e);
  }
  try {
    await tray.kill();
  } catch (e) {
    log.error("tray.kill 失败", e);
  }
  process.exit(0);
}

main().catch((e) => {
  log.error("启动失败", e);
  process.exit(1);
});
