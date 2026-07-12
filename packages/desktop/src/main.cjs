// Electron main：单实例锁 + BrowserWindow + 生命周期。kernel sidecar 在 Task 5 接入。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { createLogger } = require("./util/log.cjs");

const HIAGENT_DIR = process.env.HIAGENT_DIR || path.join(os.homedir(), ".hiagent");
const log = createLogger(path.join(HIAGENT_DIR, "logs", "desktop.log"));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860,
    icon: path.join(__dirname, "assets", "icon.ico"), // Task 6 放；缺省无碍
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // Task 5 会改成 loadURL("http://127.0.0.1:9776")；先占位确认窗口能开
  mainWindow.loadURL("data:text/html,<body style='font-family:sans-serif'>Electron shell 启动中…（Task 5 接 kernel）</body>");
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // 单实例：第二实例 → focus 既有窗口
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { log.info("已有实例，退出"); app.quit(); return; }
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  log.info(`Electron main 就绪, isPackaged=${app.isPackaged}`);
  createWindow();
});

// Win/Linux：窗口全关 = 退出（托盘「退出」也调 app.quit）
app.on("window-all-closed", () => app.quit());
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
