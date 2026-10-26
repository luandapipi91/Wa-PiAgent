// 系统通知模块：渲染进程 notice:send → 系统通知（一律静音）；通知 click → 激活应用 + 下发 action。
// isBackgrounded 为纯函数（可单测）；setupNotice 的 ipcMain/Notification 由调用方注入
// （解耦 Electron，便于单测，同 util/native-dialogs.cjs）。

// 前台判定：最小化或未聚焦即视为后台。仅 backgroundOnly:true 的请求受此拦截，非 backgroundOnly 照发。
function isBackgrounded(win) {
	return win.isMinimized() || !win.isFocused();
}

/**
 * @param {object} deps
 * @param {() => import("electron").BrowserWindow | null} deps.getMainWindow 获取主窗口（click 下行广播用）
 * @param {() => void} deps.activateApp 点通知激活应用（Dock/托盘点击同款逻辑）
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {typeof import("electron").Notification} deps.Notification
 */
function setupNotice({ getMainWindow, activateApp, ipcMain, Notification }) {
	ipcMain.handle("notice:send", (_event, payload) => {
		if (!Notification.isSupported()) {
			return { sent: false, reason: "unsupported" };
		}
		// backgroundOnly:true 仅在窗口于后台（最小化/未聚焦）时发
		if (payload.backgroundOnly && !isBackgrounded(getMainWindow())) {
			return { sent: false, reason: "foreground" };
		}
		const notification = new Notification({
			title: payload.title,
			body: payload.body,
			silent: true,
		});
		notification.on("click", () => {
			activateApp();
			// 把原始 action 载荷透传给渲染进程（不解析），广播写法同 updater.cjs 的 broadcast
			const win = getMainWindow();
			if (win && !win.isDestroyed()) {
				win.webContents.send("notice:action", payload.action);
			}
		});
		notification.show();
		return { sent: true };
	});
}

module.exports = { isBackgrounded, setupNotice };
