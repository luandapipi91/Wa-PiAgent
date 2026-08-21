// 自动更新装配层：创建 NsisUpdater、配置 GenericProvider（R2 公开读）、注册 IPC、事件翻译广播。
// translateUpdaterEvent / updaterPhases 为纯函数（可单测）；setupUpdater 依赖 Electron 环境（main 进程调用）。

const updaterPhases = [
	"checking",
	"available",
	"up-to-date",
	"downloading",
	"downloaded",
	"error",
];

// autoUpdater 事件 → 前端 updater:event 载荷（{ phase, ... }）。未知事件返回 null。
function translateUpdaterEvent({ type, info, progress, error }) {
	switch (type) {
		case "checking-for-update":
			return { phase: "checking" };
		case "update-available":
			return {
				phase: "available",
				version: info?.version ?? null,
				releaseNotes: info?.releaseNotes ?? null,
			};
		case "update-not-available":
			return { phase: "up-to-date" };
		case "download-progress":
			return {
				phase: "downloading",
				progress: progress?.percent ?? 0,
				transferred: progress?.transferred ?? 0,
				total: progress?.total ?? 0,
			};
		case "update-downloaded":
			return { phase: "downloaded", version: info?.version ?? null };
		case "error":
			return { phase: "error", message: error?.message || String(error) };
		default:
			return null;
	}
}

// —— Electron 装配（main 进程调用）——

// updater:quit-and-install 的 handler 工厂（纯逻辑，可单测；setupUpdater 依赖 Electron 无法直接测）。
// 升级安装前先 await onBeforeQuitAndInstall（停 kernel、等端口释放等优雅清理）完成，再调 quitAndInstall。
/**
 * 注意：onBeforeQuitAndInstall 回调抛错会中断 quitAndInstall（跳过安装），调用方应自行捕获异常。
 * @param {object} deps
 * @param {{ quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void }} deps.updater electron-updater 实例
 * @param {() => Promise<void>} [deps.onBeforeQuitAndInstall] 升级安装前回调（可选，未提供时直接 quitAndInstall）
 */
function makeQuitAndInstallHandler({
	updater,
	onBeforeQuitAndInstall,
	destroyTray,
	log = console.log,
}) {
	return async () => {
		await onBeforeQuitAndInstall?.();
		log("[updater] destroyTray 开始");
		destroyTray?.();
		log("[updater] destroyTray 完成");
		log("[updater] quitAndInstall 调用中…");
		updater.quitAndInstall(false, true);
		// macOS 兜底：quitAndInstall 内部走 Squirrel.Mac 退出流程（含 ShipIt 安装 + 自动重启）。
		// 如果 5 秒后进程还在（quitAndInstall 未生效，如 Tray 残留保活），强制退出。
		// 正常情况下 quitAndInstall 会在 1-2 秒内退出进程，此兜底不会触发。
		if (process.platform === "darwin") {
			setTimeout(() => {
				log("[updater] 兜底 app.exit(0)（quitAndInstall 超时未退出）");
				try {
					require("electron").app.exit(0);
				} catch {}
			}, 5_000);
		}
		return { ok: true };
	};
}

const { NsisUpdater, MacUpdater, LinuxUpdater } = require("electron-updater");

// 前端 phase → electron-updater 事件名 的显式映射表。
// 用普通对象 + 遍历，避免晦涩的链式 .map() 写法，语义一眼可懂。
const PHASE_TO_EVENT = {
	checking: "checking-for-update",
	available: "update-available",
	"up-to-date": "update-not-available",
	downloading: "download-progress",
	downloaded: "update-downloaded",
	error: "error",
};

/**
 * @param {object} deps
 * @param {() => import("electron").BrowserWindow | null} deps.getMainWindow 获取主窗口（广播用）
 * @param {(msg: string) => void} deps.log
 * @param {boolean} deps.isPackaged 是否打包版（dev 下禁用真实更新）
 * @param {string} deps.currentVersion app.getVersion()
 * @param {{ feedUrl?: string }} [deps.config] 可覆盖更新源 URL（E2E/测试指向本地 mock）
 * @param {() => Promise<void>} [deps.onBeforeQuitAndInstall] 升级安装前回调（停 kernel 等优雅清理）；
 *   调用方应自行捕获异常，失败不应阻断安装
 * @param {() => void} [deps.destroyTray] 销毁托盘（macOS 防 Tray 保活阻止退出）
 */
function setupUpdater({
	getMainWindow,
	log,
	isPackaged,
	currentVersion,
	config = {},
	onBeforeQuitAndInstall,
	destroyTray,
}) {
	const { ipcMain } = require("electron");

	// 广播：把翻译后的 payload 推到渲染进程 updater:event 通道
	const broadcast = (payload) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("updater:event", payload);
		}
	};

	// 查询当前版本 + 是否打包（前端用来决定是否显示更新 UI）
	ipcMain.handle("updater:get-info", () => ({
		appVersion: currentVersion,
		isDesktop: isPackaged,
	}));

	if (!isPackaged) {
		// dev 模式：注册占位 handler，返回不可用，避免误触发真实更新
		ipcMain.handle("updater:check", () => ({ ok: false, reason: "dev" }));
		ipcMain.handle("updater:download", () => ({ ok: false, reason: "dev" }));
		ipcMain.handle("updater:quit-and-install", () => ({
			ok: false,
			reason: "dev",
		}));
		return;
	}

	// 按平台选择 updater（显式 new，避免 autoUpdater 单例在非 Electron 环境访问抛错）
	let UpdaterClass = NsisUpdater;
	if (process.platform === "darwin") UpdaterClass = MacUpdater;
	else if (process.platform === "linux") UpdaterClass = LinuxUpdater;
	const updater = new UpdaterClass();
	updater.autoDownload = false; // 不自动下载，等用户点击后再 downloadUpdate()
	updater.logger = {
		info: (m) => log(`[updater] ${m}`),
		warn: (m) => log(`[updater] ${m}`),
		error: (m) => log(`[updater] ${m}`),
		debug: (m) => log(`[updater] ${m}`),
	};
	// 配置更新源：GenericProvider 从 R2 公开读拉 latest.yml + 安装包。
	// setFeedURL 是官方注入路径（内部自动构造 GenericProvider + clientPromise）。
	updater.setFeedURL({
		provider: "generic",
		url: config.feedUrl || "https://oss.wapiagent.top/releases/",
	});

	// 注册事件监听：把 electron-updater 原生事件翻译成前端 phase 载荷并广播
	for (const [, eventName] of Object.entries(PHASE_TO_EVENT)) {
		updater.on(eventName, (...args) => {
			const payload = translateUpdaterEvent({
				type: eventName,
				info: args[0]?.version ? args[0] : undefined,
				progress: args[0],
				error: args[0],
			});
			if (payload) broadcast(payload);
		});
	}

	// IPC：触发检查更新
	ipcMain.handle("updater:check", async () => {
		try {
			await updater.checkForUpdates();
			return { ok: true };
		} catch (e) {
			log(`[updater] check 失败: ${e.message || e}`);
			broadcast({ phase: "error", message: e.message || String(e) });
			return { ok: false, error: e.message || String(e) };
		}
	});

	// IPC：触发下载更新
	ipcMain.handle("updater:download", async () => {
		try {
			await updater.downloadUpdate();
			return { ok: true };
		} catch (e) {
			log(`[updater] download 失败: ${e.message || e}`);
			broadcast({ phase: "error", message: e.message || String(e) });
			return { ok: false, error: e.message || String(e) };
		}
	});

	// IPC：退出并安装（isSilent=false, isForceRunAfter=true）
	// 先等升级前清理（停 kernel + 等端口释放）完成，避免 Windows 下 NSIS 杀进程树不可靠导致 9778 幽灵占用
	ipcMain.handle(
		"updater:quit-and-install",
		makeQuitAndInstallHandler({
			updater,
			onBeforeQuitAndInstall,
			destroyTray,
			log: (m) => log(`[updater] ${m}`),
		}),
	);

	log("[updater] 已装配（packaged）");
}

module.exports = {
	updaterPhases,
	translateUpdaterEvent,
	setupUpdater,
	makeQuitAndInstallHandler,
};
