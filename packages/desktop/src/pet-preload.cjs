// 桌面宠物窗口专用 preload：把宿主能力挂到 window.guaguaHost（pet.html 约定的接口）。
// 页面里全部接口都是可选的——缺哪个就自动降级成「浏览器预览模式」，
// 但拖动/眼神跟随/缩放/位置记忆依赖 moveWindow + getCursorPos + getScreenInfo。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("guaguaHost", {
	// 拖动/溜达：页面算好窗口左上角后交主进程 setPosition
	moveWindow: (x, y) => ipcRenderer.send("pet:move", x, y),
	// 缩放：右键菜单滑条 50%~200% → 窗口内容尺寸
	setWindowSize: (w, h) => ipcRenderer.send("pet:size", w, h),
	// 位置与尺寸一次下发（原子）：缩放时用它，避免两次 IPC 之间的中间态造成抖动
	setWindowBounds: (x, y, w, h) => ipcRenderer.send("pet:bounds", x, y, w, h),
	// 屏幕光标（屏幕坐标，40ms 轮询）：眼神跟随、凑脸惊吓、穿透判定
	getCursorPos: () => ipcRenderer.invoke("pet:cursor"),
	// 页面同步读取：必须 sendSync（invoke 返回 Promise，页面会当成无效数据降级）
	getScreenInfo: () => ipcRenderer.sendSync("pet:screens"),
	// 配置持久化：{ scale, wander, pos }，主进程节流写盘
	saveConfig: (cfg) => ipcRenderer.send("pet:save-config", cfg),
	loadConfig: () => ipcRenderer.sendSync("pet:load-config"),
	// 透明区域点击穿透（光标不在青蛙上时让点击落到桌面）
	setClickThrough: (flag) => ipcRenderer.send("pet:click-through", flag === true),
	// 右键菜单「关闭」：销毁窗口并由主进程回执主窗口把设置开关置关
	close: () => ipcRenderer.send("pet:close"),
	// 任务完成：主窗口转发庆祝指令
	onCelebrate: (callback) => {
		const listener = () => callback();
		ipcRenderer.on("petwin:celebrate", listener);
		return () => ipcRenderer.removeListener("petwin:celebrate", listener);
	},
});
