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
	// 依赖安装失败错误页「重试」：重启应用重新执行依赖安装
	retryInstall: () => ipcRenderer.invoke("app:retry-install"),
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

// 预览独立窗口（浮动模式的承载窗口）桥：
// 浮动预览不再是主窗口内的 DOM 浮层，而是真正的系统窗口。
// - 主窗口侧：open 开窗（带初始 path/sessionId/屏幕坐标）、cmd 下发窗口指令、onEvent 接独立窗口上报
// - 独立窗口侧：act 上报动作（最小化/关闭/切回内嵌/元素回传）、setSize 缩放手柄、onEvent 收主窗口指令
// 两侧共用 onEvent（主进程统一用 previewwin:event 下行），按消息 type 自行分发。
contextBridge.exposeInMainWorld("waPiPreviewWin", {
	open: (payload) => ipcRenderer.invoke("previewwin:open", payload),
	cmd: (payload) => ipcRenderer.send("previewwin:cmd", payload),
	act: (payload) => ipcRenderer.send("previewwin:act", payload),
	setSize: (size) => ipcRenderer.send("previewwin:set-size", size),
	onEvent: (callback) => {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("previewwin:event", listener);
		return () => ipcRenderer.removeListener("previewwin:event", listener);
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
