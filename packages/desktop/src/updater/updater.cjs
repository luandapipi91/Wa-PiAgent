// 自动更新装配层：创建 NsisUpdater、配置 GenericProvider（R2 公开读）、注册 IPC、事件翻译广播。
// translateUpdaterEvent / updaterPhases / createStartupCheck 为纯函数（可单测）；
// setupUpdater 依赖 Electron 环境（main 进程调用），ipcMain / updater 工厂可注入供单测。

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
			// message 保留原错误字符串（供前端/测试兼容），raw 追加原始错误细节。
			return {
				phase: "error",
				message: error?.message || String(error),
				raw: error?.message || String(error),
			};
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

// 按平台选择 updater（显式 new，避免 autoUpdater 单例在非 Electron 环境访问抛错）
function defaultCreateUpdater() {
	let UpdaterClass = NsisUpdater;
	if (process.platform === "darwin") UpdaterClass = MacUpdater;
	else if (process.platform === "linux") UpdaterClass = LinuxUpdater;
	return new UpdaterClass();
}

// 启动检查失败后的退避重试间隔（ms）。登录自启/冷启动时网络与系统代理常晚于应用就绪：
// desktop.log 2026-11-22、11-25 两次启动检查 ERR_PROXY_CONNECTION_FAILED 后无任何重试，
// 整个会话再无更新提示，直到用户打开设置页触发重查——「只有打开设置才弹更新提醒」的根因。
const STARTUP_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];

/**
 * 启动更新检查器（纯逻辑，timer 可注入）：
 * - start()：立即检查一次；check 以 reject 表示失败（与 electron-updater checkForUpdates 一致）
 * - 失败 → 按 delays 退避重试，用完为止
 * - retryNow()：主窗口打开时调用——上一次失败则立刻再查并取消待触发的退避；在途/已成功则忽略
 * - stop()：拿到确定结果（有/无新版本）后停止一切重试
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.check
 * @param {(msg: string) => void} deps.log
 * @param {number[]} [deps.delays]
 * @param {{set:(fn:()=>void, ms:number)=>any, clear:(id:any)=>void}} [deps.timers]
 */
function createStartupCheck({ check, log, delays = STARTUP_RETRY_DELAYS_MS, timers }) {
	const t = timers ?? {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (id) => clearTimeout(id),
	};
	let failures = 0;
	let pending = null; // 待触发的退避重试 timer
	let lastFailed = false;
	let stopped = false;
	const clearPending = () => {
		if (pending != null) {
			t.clear(pending);
			pending = null;
		}
	};
	const run = () => {
		if (stopped) return;
		clearPending();
		lastFailed = false;
		Promise.resolve()
			.then(check)
			.catch((e) => {
				if (stopped) return;
				lastFailed = true;
				failures += 1;
				log(`[updater] 启动检查失败（第 ${failures} 次）: ${e?.message || e}`);
				if (failures > delays.length) return;
				pending = t.set(run, delays[failures - 1]);
			});
	};
	return {
		start: run,
		retryNow() {
			if (lastFailed) run();
		},
		stop() {
			stopped = true;
			clearPending();
		},
	};
}

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
 * @param {import("electron").IpcMain} [deps.ipcMain] 仅供单测注入；缺省取真实 electron
 * @param {() => import("electron-updater").AppUpdater} [deps.createUpdater] 仅供单测注入；缺省按平台 new
 * @returns {{ startupCheck: ReturnType<typeof createStartupCheck> | null }}
 */
function setupUpdater({
	getMainWindow,
	log,
	isPackaged,
	currentVersion,
	config = {},
	onBeforeQuitAndInstall,
	destroyTray,
	ipcMain = require("electron").ipcMain,
	createUpdater = defaultCreateUpdater,
}) {
	// 最近一次翻译后的事件：主进程启动检查往往在渲染端挂载前就已完成，
	// 渲染端挂载时经 updater:get-info 补取（有新版本 → 卡片随主窗口一起出现，不再等一次网络往返）
	let lastEvent = null;

	// 广播：把翻译后的 payload 推到渲染进程 updater:event 通道
	const broadcast = (payload) => {
		lastEvent = payload;
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send("updater:event", payload);
		}
	};

	// 查询当前版本 + 是否打包（前端用来决定是否显示更新 UI）+ 主进程启动检查的最近事件
	ipcMain.handle("updater:get-info", () => ({
		appVersion: currentVersion,
		isDesktop: isPackaged,
		lastEvent,
	}));

	if (!isPackaged) {
		// dev 模式：注册占位 handler，返回不可用，避免误触发真实更新
		ipcMain.handle("updater:check", () => ({ ok: false, reason: "dev" }));
		ipcMain.handle("updater:download", () => ({ ok: false, reason: "dev" }));
		ipcMain.handle("updater:quit-and-install", () => ({
			ok: false,
			reason: "dev",
		}));
		return { startupCheck: null };
	}

	const updater = createUpdater();
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
	// 启动检查：装配后立即发起，与内核启动/前端加载并行；失败按退避重试（见 createStartupCheck）
	const startupCheck = createStartupCheck({
		check: () => updater.checkForUpdates(),
		log: (m) => log(m),
	});
	for (const [, eventName] of Object.entries(PHASE_TO_EVENT)) {
		updater.on(eventName, (...args) => {
			const payload = translateUpdaterEvent({
				type: eventName,
				info: args[0]?.version ? args[0] : undefined,
				progress: args[0],
				error: args[0],
			});
			if (payload) broadcast(payload);
			// 有了确定结果（有/无新版本）就不再需要启动重试
			if (
				eventName === "update-available" ||
				eventName === "update-not-available"
			)
				startupCheck.stop();
		});
	}

	// IPC：触发检查更新
	ipcMain.handle("updater:check", async () => {
		try {
			await updater.checkForUpdates();
			return { ok: true };
		} catch (e) {
			log(`[updater] check 失败: ${e.message || e}`);
			broadcast({
				phase: "error",
				message: e.message || String(e),
				raw: e.message || String(e),
			});
			return {
				ok: false,
				error: e.message || String(e),
				raw: e.message || String(e),
			};
		}
	});

	// IPC：触发下载更新
	ipcMain.handle("updater:download", async () => {
		try {
			await updater.downloadUpdate();
			return { ok: true };
		} catch (e) {
			log(`[updater] download 失败: ${e.message || e}`);
			broadcast({
				phase: "error",
				message: e.message || String(e),
				raw: e.message || String(e),
			});
			return {
				ok: false,
				error: e.message || String(e),
				raw: e.message || String(e),
			};
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

	// 启动即检查：不等渲染端挂载再发起——主窗口打开时结果多半已就绪，新版本卡片能随主窗口
	// 一起出现；失败由退避重试 + revealMainWindow 的 retryNow() 兜底
	startupCheck.start();
	log("[updater] 已装配（packaged）");
	return { startupCheck };
}

module.exports = {
	updaterPhases,
	translateUpdaterEvent,
	createStartupCheck,
	setupUpdater,
	makeQuitAndInstallHandler,
};
