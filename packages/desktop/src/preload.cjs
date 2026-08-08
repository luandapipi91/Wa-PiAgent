// Preload 脚本：通过 contextBridge 暴露安全的 Electron 原生 API 给渲染进程。
// 解决 navigator.clipboard.writeText 在 Electron 中的兼容性问题。
const { contextBridge, clipboard, nativeImage, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("waPiClipboard", {
  writeText: (text) => clipboard.writeText(text),
  writeImage: (base64Png) => {
    const img = nativeImage.createFromDataURL(`data:image/png;base64,${base64Png}`);
    clipboard.writeImage(img);
  },
});

// 端口占用时启动页「重启应用」按钮调用：主进程杀占用进程后 relaunch
contextBridge.exposeInMainWorld("waPiApp", {
  restartAfterPortKill: () => ipcRenderer.invoke("app:restart-after-port-kill"),
  // 大文件附件降级用：从渲染进程的 File 对象取真实文件系统路径
  // （contextIsolation:true 下渲染进程无法直接访问 webUtils）。
  // Electron 32+ 废弃了 File.path，必须经此 API 获取。
  getPathForFile: (file) => webUtils.getPathForFile(file),
});

// 自动更新桥接：暴露给渲染进程（系统设置 → 关于 页签）
// IPC 通道由 updater/updater.cjs 的 setupUpdater 注册。
contextBridge.exposeInMainWorld("waPiUpdater", {
  getInfo: () => ipcRenderer.invoke("updater:get-info"),
  check: () => ipcRenderer.invoke("updater:check"),
  download: () => ipcRenderer.invoke("updater:download"),
  quitAndInstall: () => ipcRenderer.invoke("updater:quit-and-install"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("updater:event", listener);
    return () => ipcRenderer.removeListener("updater:event", listener);
  },
});
