// Electron main：单实例锁 + kernel sidecar + BrowserWindow + 生命周期 + 退出清理。
const { app, BrowserWindow, Menu } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { createLogger } = require("./util/log.cjs");

const HIAGENT_DIR = process.env.HIAGENT_DIR || path.join(os.homedir(), ".hiagent");
const log = createLogger(path.join(HIAGENT_DIR, "logs", "desktop.log"));

let mainWindow = null;
let sidecar = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    icon: path.join(__dirname, "assets", "icon.ico"), // Task 6 放；缺省无碍
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // 点关闭按钮 → 最小化到托盘，不退出
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (process.platform === "darwin") app.dock.hide();
    }
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
  const trayIconName = process.platform === "darwin" ? "tray_darwin.png"
    : process.platform === "win32" ? "tray_windows.ico"
    : "tray_linux.png";
  startTray({
    iconPath: path.join(__dirname, "assets", trayIconName),
    onOpen: () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); if (process.platform === "darwin") app.dock.show(); } },
    onQuit: () => app.quit(),
  });

  // 应用菜单：macOS 保留中文最小菜单；Windows/Linux 隐藏菜单栏
  const { buildAppMenuTemplate } = require("./util/menu.cjs");
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(app.name)));
  } else {
    Menu.setApplicationMenu(null);
  }

  // kernel sidecar（解释运行；首启 Defender 扫描可能要几分钟，第二次起变快）
  const { startSidecar, WS_PORT } = require("./kernel-sidecar.cjs");
  const { resolveKernelDir, resolveWebDir } = require("./util/paths.cjs");
  const kernelDir = resolveKernelDir(app.isPackaged, process.resourcesPath, process.env);
  const webDir = resolveWebDir(app.isPackaged, process.resourcesPath, process.env);
  // packaged 下 sidecar 二进制已重命名为 hiagent-kernel（分发进程名不暴露 bun）；dev 仍用 host bun。
  const kernelExe = path.join(kernelDir, process.platform === "win32" ? "hiagent-kernel.exe" : "hiagent-kernel");
  try {
    sidecar = await startSidecar({ isPackaged: app.isPackaged, kernelDir, webDir, kernelExe, log });
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
app.on("before-quit", () => { isQuitting = true; cleanup(); });

// 窗口关闭 → 隐藏到托盘；保持后台运行（真正退出时不阻止）
app.on("window-all-closed", (event) => {
  if (!isQuitting) event.preventDefault();
});

// macOS 点 Dock 图标 / 重新激活时恢复窗口
app.on("activate", () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); app.dock.show(); }
  else createWindow();
});

process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
