// Preload 脚本：通过 contextBridge 暴露安全的 Electron 原生 API 给渲染进程。
// 解决 navigator.clipboard.writeText 在 Electron 中的兼容性问题。
const {
	contextBridge,
	clipboard,
	nativeImage,
	ipcRenderer,
	webUtils,
} = require("electron");

contextBridge.exposeInMainWorld("waPiClipboard", {
	writeText: (text) => clipboard.writeText(text),
	writeImage: (base64Png) => {
		const img = nativeImage.createFromDataURL(
			`data:image/png;base64,${base64Png}`,
		);
		clipboard.writeImage(img);
	},
});

// 端口占用时启动页「换端口启动」/「退出」按钮调用：
// - switchPortStart：主进程找可用端口后 relaunch 带新端口
// - quit：直接退出应用（splash 无边框，错误态下的主动退出途径）
contextBridge.exposeInMainWorld("waPiApp", {
	restartAfterPortKill: () => ipcRenderer.invoke("app:restart-after-port-kill"),
	switchPortStart: () => ipcRenderer.invoke("app:switch-port-start"),
	quit: () => ipcRenderer.invoke("app:quit"),
	// 大文件附件降级用：从渲染进程的 File 对象取真实文件系统路径
	// （contextIsolation:true 下渲染进程无法直接访问 webUtils）。
	// Electron 32+ 废弃了 File.path，必须经此 API 获取。
	getPathForFile: (file) => webUtils.getPathForFile(file),
	// 开机自启：读取/设置系统登录项
	getLoginItem: () => ipcRenderer.invoke("app:get-login-item"),
	setLoginItem: (enabled) => ipcRenderer.invoke("app:set-login-item", enabled),
	// 原生系统文件选择对话框：附件「选择要发送的文件」（多选，返回路径数组，取消返回 []）
	showOpenFileDialog: () => ipcRenderer.invoke("dialog:open-files"),
	// 原生系统目录选择对话框：技能「添加目录」（返回目录路径，取消返回 null）
	showOpenDirectoryDialog: () => ipcRenderer.invoke("dialog:open-directory"),
	// 在系统文件管理器定位路径：技能「打开技能文件夹」
	showItemInFolder: (filePath) =>
		ipcRenderer.invoke("shell:show-item-in-folder", filePath),
});

// 外链子窗口地址栏（link-window.html）专用：加载/同步地址。
// 仅子窗口壳页面调用；主窗口/splash 页面不会触发这些 IPC。
contextBridge.exposeInMainWorld("waPiLinkWin", {
	load: (url) => ipcRenderer.send("linkwin:load", String(url)),
	ready: () => ipcRenderer.send("linkwin:ready"),
	onUrlChanged: (callback) => {
		const listener = (_event, url) => callback(url);
		ipcRenderer.on("linkwin:url-changed", listener);
		return () => ipcRenderer.removeListener("linkwin:url-changed", listener);
	},
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
