// Preload 脚本：通过 contextBridge 暴露安全的 Electron 原生 API 给渲染进程。
// 解决 navigator.clipboard.writeText 在 Electron 中的兼容性问题。
const { contextBridge, clipboard, nativeImage, ipcRenderer } = require("electron");

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
});
