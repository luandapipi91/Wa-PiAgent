// Electron main：单实例锁 + kernel sidecar + BrowserWindow + 生命周期 + 退出清理。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { createLogger } = require("./util/log.cjs");

const HIAGENT_DIR = process.env.HIAGENT_DIR || path.join(os.homedir(), ".hiagent");
const log = createLogger(path.join(HIAGENT_DIR, "logs", "desktop.log"));

let mainWindow = null;
let sidecar = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    icon: path.join(__dirname, "assets", "icon.ico"), // Task 6 放；缺省无碍
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  // 单实例：第二实例 → focus 既有窗口
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { log.info("已有实例，退出"); app.quit(); return; }
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  log.info(`Electron main 就绪, isPackaged=${app.isPackaged}`);

  // 窗口 + 托盘【立即】出现（显示"启动中"），不等内核——内核首启被 Defender 扫描要数分钟，
  // 不能让用户这几分钟啥都看不到。内核后台起好后再 loadURL 切到真实页面。
  createWindow();
  mainWindow.loadURL("data:text/html;charset=utf-8,<body style='font-family:system-ui;padding:48px;color:#333'>HiAgent 启动中，正在加载内核…</body>");
  mainWindow.focus();
  const { startTray } = require("./tray.cjs");
  startTray({
    iconPath: path.join(__dirname, "assets", "icon.ico"),
    onOpen: () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
    onQuit: () => app.quit(),
  });

  // kernel sidecar（解释运行；首启 Defender 扫描可能要几分钟，第二次起变快）
  const { startSidecar, WS_PORT } = require("./kernel-sidecar.cjs");
  const { resolveKernelDir, resolveWebDir } = require("./util/paths.cjs");
  const kernelDir = resolveKernelDir(app.isPackaged, process.resourcesPath, process.env);
  const webDir = resolveWebDir(app.isPackaged, process.resourcesPath, process.env);
  const bunExe = path.join(kernelDir, process.platform === "win32" ? "bun.exe" : "bun");
  try {
    sidecar = await startSidecar({ isPackaged: app.isPackaged, kernelDir, webDir, bunExe, log });
    mainWindow.loadURL(`http://127.0.0.1:${WS_PORT}`);   // 内核就绪 → 切到真实 hiagent 页面
  } catch (e) {
    log.error("kernel 启动失败", e);
    mainWindow.loadURL("data:text/html;charset=utf-8,<body style='font-family:system-ui;padding:48px;color:#a00'>内核启动失败：" + String(e.message || e) + "</body>");
  }
});

async function cleanup() {
  log.info("退出清理");
  try { if (sidecar) sidecar.stop(); } catch {}
  await log.flush();
}
app.on("before-quit", () => { cleanup(); });

// Win/Linux：窗口全关 = 退出（托盘「退出」也调 app.quit）
app.on("window-all-closed", () => app.quit());
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
