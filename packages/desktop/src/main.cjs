// Electron main：启动页(splash) + kernel sidecar + BrowserWindow + 生命周期 + 退出清理。
const {
	app,
	BrowserWindow,
	WebContentsView,
	Menu,
	session,
	desktopCapturer,
	ipcMain,
	nativeTheme,
	dialog,
	shell,
} = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createLogger } = require("./util/log.cjs");
const { gpuSwitchesFor } = require("./util/gpu-switches.cjs");
const { summarizeGpuStatus } = require("./util/gpu-status.cjs");
const { createStartupTimeline } = require("./util/startup-timeline.cjs");

// 启动时间线：定位「进程启动 → 主窗口首帧」各阶段耗时。
// 以前这段（尤其是「内核就绪 → 首帧」）没有任何埋点，两个平台报的「启动页空白/
// 进度条卡住/很久才出界面」因此无法定位。日志里搜 [startup] 即可看到全量时间线。
const startup = createStartupTimeline();
// Electron 进程创建 → 主进程模块开始执行的间隔（拿不到时记 0）
const BOOT_OFFSET_MS =
	typeof process.getCreationTime === "function" && process.getCreationTime()
		? Date.now() - process.getCreationTime()
		: 0;
const {
	isPortInUse,
	killPortOccupants,
	waitPortReleased,
} = require("./util/port.cjs");
const {
	registerProcess,
	unregisterProcess,
	sweepRegistry,
} = require("./util/process-registry.cjs");
const { attemptSelfHeal } = require("./util/startup-heal.cjs");
const { switchPortAndRelaunch } = require("./util/port-switch.cjs");

// 与 kernel 侧 WA_PI_DIR 一致（~/.pi/agent，env 可覆盖）：
const WA_PI_DIR =
	process.env.WA_PI_DIR || path.join(os.homedir(), ".pi", "agent");
const log = createLogger(path.join(WA_PI_DIR, "logs", "desktop.log"));

// 语言来源：桌面主进程不经过 react-i18next（desktop 无它），且启动进度窗早于前端挂载，
// 不能依赖前端传语言。用 Electron app.getLocale() 定模块级 LOCALE，内联最简 zh/en 文案字典 + t()。
// ⚠️ app.getLocale() 必须在 app ready 之后调用才返回真实系统 locale——ready 前（模块顶层）
// 返回空串（Electron 43 实测：before=""，after="zh-CN"）。曾因在模块顶层求值得到空串 →
// LOCALE 恒为 "en" → 中文 mac 打包版首启 splash/进度文案显示英文。故此处仅以 zh 占位，
// whenReady 开头（任何 splash/t() 使用之前）重算真实值。
let LOCALE = "zh";
// 启动进度 / 面向用户文案字典（zh/en 各一份，key 覆盖 main.cjs 全部透过 setProgress 面向用户的文案）。
const MSG = {
	zh: {
		initializing: "正在初始化…",
		noPort: "未找到可用端口，请检查网络或重启电脑后再试。",
		portOccupiedAutoSwitch: "检测到端口占用，自动换端口启动…",
		portOccupiedAutoCleanup: "检测到端口占用，正在自动清理…",
		detectingNode: "正在检测 Node.js…",
		preparingDeps: "正在准备依赖…",
		downloadingDeps: "正在下载依赖…",
		startingKernel: "正在启动内核…",
		loadingInterface: "正在加载界面…",
		ready: "就绪",
		depsInstallFailed: "依赖安装失败，请检查网络后重启",
		kernelStartFailed: "内核启动失败",
		depsInstallFailedTitle: "内核依赖安装失败",
		depsInstallFailedDesc:
			"已自动重试多次。请检查网络连接后点击重试；若反复失败，可能是网络无法访问依赖源（npmmirror / npmjs），请切换网络后重试。",
		retry: "重试",
		quit: "退出",
		restarting: "重启中…",
	},
	en: {
		initializing: "Initializing…",
		noPort:
			"No available port found. Check your network or restart and try again.",
		portOccupiedAutoSwitch: "Port in use — switching to a free port…",
		portOccupiedAutoCleanup: "Port in use — cleaning up automatically…",
		detectingNode: "Checking for Node.js…",
		preparingDeps: "Preparing dependencies…",
		downloadingDeps: "Downloading dependencies…",
		startingKernel: "Starting kernel…",
		loadingInterface: "Loading interface…",
		ready: "Ready",
		depsInstallFailed:
			"Dependency installation failed. Check your network and restart",
		kernelStartFailed: "Kernel failed to start",
		depsInstallFailedTitle: "Kernel dependency installation failed",
		depsInstallFailedDesc:
			"Automatically retried multiple times. Check your network connection and click Retry; if it keeps failing, the network may be unable to reach the dependency sources (npmmirror / npmjs). Switch networks and try again.",
		retry: "Retry",
		quit: "Quit",
		restarting: "Restarting…",
	},
};
const t = (k) => MSG[LOCALE][k] ?? MSG.zh[k];

// 进程登记簿（G）：kernel 启动登记 / 退出自删 / 启动清扫，全程依赖注入便于测试
const registryOpts = {
	fs,
	spawnSync,
	now: () => Date.now(),
	waPiDir: WA_PI_DIR,
	log: (m) => log.info(m),
};

// 与前端 --canvas 对齐：主窗口/启动页用同色底，消除首帧白屏闪烁
const CANVAS_BG = "#F5F5F7";
const BRAND_GREEN = "#4BA26F";

// 「跟随系统」在 Windows 上需区分「系统主题」与「应用主题」：
// 前端 prefers-color-scheme 默认跟随「应用主题」（AppsUseLightTheme），而用户期望跟随
// 「系统主题」（SystemUsesLightTheme）。用 shouldUseDarkColorsForSystemIntegratedUI
// （Windows 上区分两者）显式同步 themeSource，使 prefers-color-scheme 对齐系统主题。
function syncThemeSource() {
	try {
		const sysDark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
		const target = sysDark ? "dark" : "light";
		if (nativeTheme.themeSource !== target) {
			nativeTheme.themeSource = target;
		}
	} catch {}
}

let splashWindow = null;
let mainWindow = null;
// 预览独立窗口（浮动模式的承载窗口）：单例，主窗口收起时同步隐藏
let previewWindow = null;
let sidecar = null;
let isQuitting = false;
let isUpdating = false;
let trayInstance = null;
// kernel 固定端口：端口变化会导致前端 IndexedDB origin 改变（跨 origin 数据不可见）。
// 换端口启动时通过命令行参数 --wa-pi-port 传递新端口（Windows 上 app.relaunch 的 env 替换不可靠），
// 但 Windows packaged 应用 app.relaunch 的 args 也可能丢失（Electron #33686）——临时文件兑底。
// 不持久化：临时文件读取后即删除，下次启动回到默认端口。
// 优先级：临时文件(.switch-port，一次性) > --wa-pi-port 参数 > WA_PI_WS_PORT 环境变量 > 默认 9778。
// 前端无需适配：API/SSE 走相对路径，自动跟随 loadURL 的端口。
const SWITCH_PORT_FILE = path.join(WA_PI_DIR, ".switch-port");
function readSwitchPort() {
	try {
		const n = Number(fs.readFileSync(SWITCH_PORT_FILE, "utf8").trim());
		fs.unlinkSync(SWITCH_PORT_FILE); // 一次性：读取后删除，下次启动回到默认
		return Number.isFinite(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
}
function writeSwitchPort(port) {
	try {
		fs.writeFileSync(SWITCH_PORT_FILE, String(port), "utf8");
	} catch (e) {
		console.error("[switch-port] 写入失败", e);
	}
}
const SWITCH_PORT = readSwitchPort();
const PORT_ARG = process.argv.find((a) => a.startsWith("--wa-pi-port="));
function resolveFixedPort() {
	if (SWITCH_PORT) return SWITCH_PORT;
	if (PORT_ARG) {
		const n = Number(PORT_ARG.split("=")[1]);
		if (n > 0) return n;
	}
	const envPort = Number(process.env.WA_PI_WS_PORT);
	if (envPort > 0) return envPort;
	return 9778;
}
const FIXED_PORT = resolveFixedPort();

// 自动换端口启动：自愈失败/清理失败时静默找下一个可用端口并 relaunch，不打扰用户。
// 找不到可用端口返回 false（调用方决定提示文案）。依赖注入见 switchPortAndRelaunch。
async function autoSwitchPortAndRelaunch() {
	const { findAvailablePort } = require("./util/port.cjs");
	return switchPortAndRelaunch(FIXED_PORT, {
		findAvailablePort,
		writeSwitchPort,
		relaunch: (opts) => app.relaunch(opts),
		exit: (code) => app.exit(code),
		argv: process.argv.slice(1),
		env: process.env,
		log: (m) => log.info(m),
	});
}
// 内核是否就绪（mainWindow 是否已加载真实页面）。未就绪时点托盘/Dock 应聚焦启动页，而非弹出空白主窗口。
let kernelReady = false;

// 启动页 HTML：logo 内联成 base64（规避 file:// 与 asar 路径差异），整页走 data: URL 即时渲染、不闪屏。
function buildSplashURL() {
	const logoPath = path.join(__dirname, "assets", "icon.png");
	const logoB64 = fs.existsSync(logoPath)
		? fs.readFileSync(logoPath).toString("base64")
		: "";
	const { buildSplashHTML } = require("./util/splash-html.cjs");
	const html = buildSplashHTML({
		logoB64,
		canvasBg: CANVAS_BG,
		brandGreen: BRAND_GREEN,
		locale: LOCALE,
	});
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
function createSplash() {
	splashWindow = new BrowserWindow({
		width: 360,
		height: 440,
		frame: false,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		backgroundColor: CANVAS_BG,
		icon: path.join(__dirname, "assets", "icon.ico"),
		show: true, // 立即显示：内核首启被 Defender 扫描可能数分钟，这几分钟用户要看到进度而非白屏
		// sandbox:false：preload 需 require('electron').clipboard 注入 waPiClipboard（sandbox 下该模块不在白名单，会导致复制失效）
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: false,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});
	splashWindow.loadURL(buildSplashURL());
	// 启动页自身的时间线：did-finish-load 只说明 HTML 解析完，用户真正看到的是首帧合成。
	// 两者分开打点，才能区分「启动页加载慢」与「加载完了却不出帧」（GPU 合成退化的特征）。
	splashWindow.webContents.once("did-finish-load", () => {
		startup.mark("splashLoaded");
		splashWindow?.webContents
			?.executeJavaScript(
				"new Promise(r=>requestAnimationFrame(()=>r(Math.round(performance.now()))))",
			)
			.then(() => startup.mark("splashFirstFrame"))
			.catch(() => {});
	});
	// 启动页自身的诊断：卡住/白屏时至少有痕迹（此前完全静默）
	splashWindow.webContents.on("unresponsive", () =>
		log.error("[startup] 启动页渲染进程无响应（窗口卡死）"),
	);
	splashWindow.webContents.on("render-process-gone", (_e, d) =>
		log.error(`[startup] 启动页渲染进程退出: ${JSON.stringify(d)}`),
	);
	splashWindow.on("closed", () => {
		splashWindow = null;
	});
}

// packaged 下运行时只有 WaPiKernel（bun --compile 编译产物，BUN_BE_BUN=1 时充当 bun CLI），
// PATH 上缺少 node/npm/bun/npx。动态插件可能需要 bun 来装 npm 包，装好的 bin 脚本 shebang
// 又需要 node。因此在 WA_PI_DIR/bin 下创建 bun / node 符号链接指向 WaPiKernel，
// findSystemNode + ensureRuntimeBinLinks 已提取到 ./util/runtime-bin.cjs（可独立测试）

// 更新启动页进度条与文案（p<0 表示错误态：文案红色）
function setProgress(pct, text, isError = false) {
	if (!splashWindow || splashWindow.isDestroyed()) return;
	const p = isError ? -1 : pct;
	splashWindow.webContents
		.executeJavaScript(
			`window.__setProgress&&window.__setProgress(${p},${JSON.stringify(text || "")})`,
		)
		.catch(() => {});
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 860,
		show: false, // 隐藏直到内核页面渲染就绪，避免白屏
		autoHideMenuBar: true, // Win/Linux 应用菜单存在时会显示菜单栏；隐藏保外观，Alt 可唤出
		backgroundColor: CANVAS_BG,
		icon: path.join(__dirname, "assets", "icon.ico"),
		// sandbox:false：preload 需 require('electron').clipboard 注入 waPiClipboard（sandbox 下该模块不在白名单，会导致复制失效）
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: false,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});
	// 外链子窗口集合：移除 parent 后，主窗口收起时需手动同步隐藏子窗口
	const childWindows = new Set();
	// 点关闭按钮 → 最小化到托盘，不退出
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			event.preventDefault();
			mainWindow.hide();
			// 主窗口收起时同步隐藏所有外链子窗口（原先靠 parent owned-window 行为自动跟随）
			for (const w of childWindows) {
				if (!w.isDestroyed()) w.hide();
			}
			// 预览独立窗口同为无 parent 窗口，需手动同步隐藏
			if (previewWindow && !previewWindow.isDestroyed()) previewWindow.hide();
			if (process.platform === "darwin") app.dock.hide();
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	// 链接处理：外部链接在应用内新窗口（BrowserWindow 子窗口）打开，不劫持主窗口。
	// 浏览器（web）端 target="_blank" 天然新窗口/新标签页，Electron 端由这里统一接管。
	// isSelfUrl 仅用于防御「无 target=_blank 的当前窗口导航」被应用自身地址（相对路径
	// 被解析为 localhost URL）劫持——FileViewer 里的相对路径链接由前端 onClick 拦截在
	// 预览器内打开，不走到这里；用户/agent 提供的 localhost 服务链接（如视觉伴侣页面）
	// 是显式 target=_blank 点击，应放行到应用内新窗口。
	const isSelfUrl = (url) =>
		/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);
	// 地址栏规范化为可导航 URL：无协议时补 https://；只放行 http/https（防 javascript:/file: 注入）
	const normalizeUrl = (raw) => {
		const t = String(raw || "").trim();
		if (!t) return null;
		const withProto = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
		if (!/^https?:\/\//i.test(withProto)) return null;
		return withProto;
	};

	// 外链子窗口：BrowserWindow 壳（本地地址栏页面）+ WebContentsView 承载网页内容。
	// 地址栏支持显示当前地址 / 复制地址 / 修改地址后导航；网页内容不挂 preload、sandbox 开启。
	const openInChildWindow = (url) => {
		const BAR_HEIGHT = 44;
		// 不设置 parent：macOS 上带 parent 的 child window 拖到不同缩放的扩展显示器会消失（Electron #31815）
		const child = new BrowserWindow({
			title: "WA PI Agent",
			width: 1000,
			height: 700,
			backgroundColor: "#ffffff",
			autoHideMenuBar: true, // 同主窗口：隐藏菜单栏保外观，编辑快捷键仍生效
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: false,
				preload: path.join(__dirname, "preload.cjs"),
			},
		});
		childWindows.add(child);
		child.loadFile(path.join(__dirname, "assets", "link-window.html"));

		// 网页内容视图：外部内容，保持最强隔离（不挂 preload）
		const view = new WebContentsView({
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
			},
		});
		child.contentView.addChildView(view);
		const updateViewBounds = () => {
			const [w, h] = child.getContentSize();
			view.setBounds({
				x: 0,
				y: BAR_HEIGHT,
				width: w,
				height: Math.max(h - BAR_HEIGHT, 0),
			});
		};
		updateViewBounds();
		child.on("resize", updateViewBounds);

		view.webContents.loadURL(url);

		// 内容导航 → 地址栏同步
		const sendCurrentUrl = () => {
			if (child.isDestroyed()) return;
			const cur = view.webContents.getURL();
			if (cur) child.webContents.send("linkwin:url-changed", cur);
		};
		view.webContents.on("did-navigate", sendCurrentUrl);
		view.webContents.on("did-navigate-in-page", sendCurrentUrl);

		// 地址栏 → 内容导航（仅响应本子窗口的地址栏请求，多窗口并发不串）
		const onLoad = (event, rawUrl) => {
			if (event.sender !== child.webContents) return;
			const target = normalizeUrl(rawUrl);
			if (target) view.webContents.loadURL(target);
		};
		const onReady = (event) => {
			if (event.sender === child.webContents) sendCurrentUrl();
		};
		ipcMain.on("linkwin:load", onLoad);
		ipcMain.on("linkwin:ready", onReady);

		// 内容里 target=_blank / window.open → 递归新开子窗口
		view.webContents.setWindowOpenHandler(({ url: childUrl }) => {
			openInChildWindow(childUrl);
			return { action: "deny" };
		});

		child.on("closed", () => {
			childWindows.delete(child);
			ipcMain.removeListener("linkwin:load", onLoad);
			ipcMain.removeListener("linkwin:ready", onReady);
		});
	};
	// target=_blank / window.open：用户明确要新开，一律应用内新窗口
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^(https?:|mailto:|tel:)/i.test(url)) {
			openInChildWindow(url);
		}
		return { action: "deny" };
	});
	// 防御：无 target=_blank 的链接会在当前窗口导航，阻止主窗口被外部地址劫持；
	// 非应用自身地址转应用内新窗口
	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (!isSelfUrl(url)) {
			event.preventDefault();
			openInChildWindow(url);
		}
	});
	// 调试：F12 / Cmd+Alt+I 打开 DevTools（打包态排查持久化等问题）
	mainWindow.webContents.on("before-input-event", (_event, input) => {
		if (input.type !== "keyDown") return;
		if (
			input.key === "F12" ||
			((input.control || input.meta) &&
				input.alt &&
				input.key.toLowerCase() === "i")
		) {
			mainWindow.webContents.toggleDevTools();
		}
	});
}

// 启动页 → 主窗口切换：关启动页、显示主窗口
function revealMainWindow() {
	kernelReady = true;
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.show();
		mainWindow.focus();
		startup.mark("windowShown");
		if (process.platform === "darwin") app.dock.show();
	}
	if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
}

// 点 Dock/托盘/第二实例时的统一激活逻辑：内核就绪→主窗口；否则→启动页
function activateApp() {
	if (kernelReady && mainWindow) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
		if (process.platform === "darwin") app.dock.show();
	} else if (splashWindow) {
		splashWindow.show();
		splashWindow.focus();
	}
}

// GPU 硬件加速开关：必须在 app.whenReady 之前 appendSwitch 才生效。
//
// 2026-09-18 修正（原实现无条件加四个开关，在两个平台都把界面拖垮）：
// ①这四个开关最初是为 Windows 双显卡笔记本（NVIDIA dGPU + Intel iGPU）加的——那里
//    Electron 43 默认未启用硬件加速、进程 GPU 占用为 0，需要强制打开；
// ②但其中 `use-angle=d3d11` 是 **Windows 专属** ANGLE 后端，在 macOS 上强制指定后
//    Chromium 会把 GPU 整个关掉：实测 app.getGPUFeatureStatus() 从
//    `gpu_compositing=enabled / gpuDevice.active=true` 退化为
//    `gpu_compositing=disabled_software / gpuDevice.active=false`（软件渲染），
//    同一启动页的 rAF 出帧率从 60fps 掉到 6~16fps；
// ③表现就是用户报的「启动页长时间空白、进度条停在低位不动、很久才渲染出界面」。
// 故按平台门控：只有 Windows 加（见 util/gpu-switches.cjs，含单测）。
// 真实生效的 GPU 状态由下方 getGPUInfo 日志里的 [GPU] 行自证（⚠️ = 软件渲染）。
for (const [switchName, switchValue] of gpuSwitchesFor(process.platform)) {
	if (switchValue) app.commandLine.appendSwitch(switchName, switchValue);
	else app.commandLine.appendSwitch(switchName);
}
app.whenReady().then(async () => {
	startup.mark("ready");
	// ready 后重算界面语言（ready 前 getLocale 返回空串，见顶部 LOCALE 注释）
	LOCALE = app.getLocale().startsWith("zh") ? "zh" : "en";
	// 「跟随系统」主题：同步系统主题到 themeSource（Windows 区分系统/应用主题），
	// 并监听系统主题变化（nativeTheme updated）持续同步。
	syncThemeSource();
	nativeTheme.on("updated", syncThemeSource);

	// GPU 信息取证：确认合成到底有没有走硬件加速（vs 软件渲染）。
	// 注意 log.info 只接受一个参数（log.cjs 的 info: (m) => write(...)），
	// 以前写成 log.info("GPU 信息:", JSON.stringify(...)) 导致第二个参数被丢弃、
	// 日志一直是空的——只能用单字符串摘要（util/gpu-status.cjs）。
	const logGpuInfo = (gpuDevice) => {
		let feature = null;
		try {
			feature = app.getGPUFeatureStatus();
		} catch {
			/* 拿不到就记 unknown，不影响启动 */
		}
		log.info(`[GPU] ${summarizeGpuStatus(feature, gpuDevice)}`);
	};
	app
		.getGPUInfo("complete")
		.then((info) => logGpuInfo(info?.gpuDevice))
		.catch(() => logGpuInfo(undefined));
	// 单实例：第二实例 → 激活既有窗口
	const gotLock = app.requestSingleInstanceLock();
	if (!gotLock) {
		log.info("已有实例，退出");
		app.quit();
		return;
	}
	app.on("second-instance", activateApp);
	log.info(`Electron main 就绪, isPackaged=${app.isPackaged}`);

	// 录音前提：自动批准 getDisplayMedia（系统回环音频，无共享框）+ 麦克风免弹窗（spec B）
	const { setupRecordingHandlers } = require("./util/recording-handlers.cjs");
	setupRecordingHandlers(session.defaultSession, desktopCapturer);

	// 1) 启动页【立即】出现 + 主窗口隐藏创建（等内核就绪再渲染显示）
	createSplash();
	startup.mark("splashCreated");
	setProgress(10, t("initializing"));
	createWindow();
	startup.mark("mainWindowCreated");

	// 自动更新：系统设置 → 关于（Cloudflare R2 + electron-updater）
	// WA_PI_UPDATER_FEED_URL 仅供 E2E/测试指向本地 mock，生产默认走 OSS 公开读
	const { setupUpdater } = require("./updater/updater.cjs");
	setupUpdater({
		getMainWindow: () => mainWindow,
		log: (m) => log.info(m),
		isPackaged: app.isPackaged,
		currentVersion: app.getVersion(),
		config: {
			feedUrl: process.env.WA_PI_UPDATER_FEED_URL || undefined,
		},
		// 升级安装前优雅停 kernel：停 sidecar（同步阻塞杀进程树）→ 等端口真正释放 →
		// 登记簿兜底清扫（清运行期 kernel 重启换 pid 等残留）→ 自删登记。
		// sidecar 在下方 startSidecar 之后才赋值，这里必须用 getter 闭包读当前值，
		// 不能引用声明时（null）的值。全程 best-effort：异常只记日志，绝不阻断安装。
		onBeforeQuitAndInstall: async () => {
			isUpdating = true;
			try {
				const sc = sidecar;
				if (sc) sc.stop();
				const released = await waitPortReleased(FIXED_PORT);
				if (!released) {
					log.error(`[updater] 升级前端口 ${FIXED_PORT} 未在预期窗口内释放`);
				}
				try {
					const r = sweepRegistry(registryOpts);
					if (
						r.killed.length ||
						r.deleted.length ||
						r.skipped.length ||
						r.errors.length
					) {
						log.info(
							`[registry] 升级前清扫: killed=[${r.killed.join(",") || "无"}] ` +
								`deleted=[${r.deleted.join(",") || "无"}] skipped=[${r.skipped.join(",") || "无"}] ` +
								`errors=[${r.errors.map((e) => `${e.pid}:${e.reason}`).join(";") || "无"}]`,
						);
					}
				} catch (e) {
					log.error("[registry] 升级前清扫失败", e);
				}
				if (sc) unregisterProcess(sc.pid, registryOpts);
			} catch (e) {
				log.error("[updater] 升级前清理失败（继续安装）", e);
			}
		},
		destroyTray: () => {
			try {
				trayInstance?.destroy();
			} catch {}
			trayInstance = null;
		},
	});

	// 端口被占用时启动页「换端口启动」按钮的处理：杀掉占用进程后重启本应用（保留；
	// 与 switch-port-start 并存，重启仍优先清理占用端口）
	ipcMain.handle("app:restart-after-port-kill", async () => {
		const pids = await killPortOccupants(FIXED_PORT, undefined, (m) =>
			log.info(m),
		);
		log.info(
			`[port-kill] 端口 ${FIXED_PORT} 占用进程已清理: ${pids.join(", ") || "(无)"}`,
		);
		// 短暂等待端口真正释放
		await new Promise((r) => setTimeout(r, 500));
		// 清理后仍占用：幽灵句柄由无我方特征的进程持有（如 agent 帮用户起的 dev server），
		// 自动清理无能为力——不再提示用户，静默自动换端口启动
		if (await isPortInUse(FIXED_PORT)) {
			log.error(`[port-kill] 端口 ${FIXED_PORT} 清理后仍被占用，自动换端口启动`);
			const switched = await autoSwitchPortAndRelaunch();
			if (!switched) {
				log.error(`[port-switch] 未找到可用端口（从 ${FIXED_PORT + 1} 起）`);
				setProgress(-1, t("noPort"));
				splashWindow?.webContents
					?.executeJavaScript(
						"window.__showActions&&window.__showActions({quit:true})",
					)
					.catch(() => {});
			}
			return;
		}
		app.relaunch();
		app.exit(0);
	});

	// 端口自愈失败后自动换端口启动（splash 不再展示按钮；保留 handler 供 preload/程序化调用）：
	// 从下一个端口开始找可用端口，relaunch 带新端口
	ipcMain.handle("app:switch-port-start", async () => {
		const switched = await autoSwitchPortAndRelaunch();
		if (!switched) {
			log.error(`[port-switch] 找不到可用端口（从 ${FIXED_PORT + 1} 起）`);
			setProgress(-1, t("noPort"));
		}
	});

	// 启动页错误态「退出」按钮：直接退出应用（splash 无边框，这是错误态唯一主动退出途径）
	ipcMain.handle("app:quit", () => {
		app.quit();
	});

	// 依赖安装失败错误页「重试」按钮：重启应用，启动流程会重新执行依赖安装。
	// （失败时不写 .installed-version 标记，重启即自动重试——这里的按钮省去手动关闭重开）
	ipcMain.handle("app:retry-install", () => {
		app.relaunch();
		app.exit(0);
	});

	// 开机自启：读取/设置系统登录项
	ipcMain.handle("app:get-login-item", () => {
		return app.getLoginItemSettings().openAtLogin;
	});

	ipcMain.handle("app:set-login-item", (_e, enabled) => {
		app.setLoginItemSettings({ openAtLogin: enabled });
		return app.getLoginItemSettings().openAtLogin;
	});

	// 原生文件对话框与 shell 定位（附件选文件 / 技能目录 / 打开技能文件夹）
	const { setupNativeDialogs } = require("./util/native-dialogs.cjs");
	setupNativeDialogs({ dialog, shell, ipcMain, BrowserWindow });

	// 托盘 + 菜单
	const { startTray } = require("./tray.cjs");
	const TRAY_ICONS = {
		darwin: "tray_darwin.png",
		win32: "tray_windows.ico",
	};
	const trayIconName = TRAY_ICONS[process.platform] || "tray_linux.png";
	trayInstance = startTray({
		iconPath: path.join(__dirname, "assets", trayIconName),
		onOpen: activateApp,
		onQuit: () => app.quit(),
	});
	const {
		buildAppMenuTemplate,
		buildEditMenuTemplate,
	} = require("./util/menu.cjs");
	if (process.platform === "darwin") {
		Menu.setApplicationMenu(
			Menu.buildFromTemplate(buildAppMenuTemplate(app.name)),
		);
	} else {
		// Windows/Linux：编辑快捷键（Ctrl+Z / Ctrl+Shift+Z / Ctrl+X/C/V/A）依赖应用菜单中
		// 带 role 的菜单项绑定，置 null 会让输入框撤销/剪切/粘贴等全部失效。
		// 设置编辑菜单保住快捷键，菜单栏由窗口 autoHideMenuBar 隐藏，界面外观不变。
		Menu.setApplicationMenu(Menu.buildFromTemplate(buildEditMenuTemplate()));
	}

	// 2) kernel sidecar（解释运行；首启 Defender 扫描可能要几分钟）
	const { startSidecar } = require("./kernel-sidecar.cjs");
	const {
		resolveKernelDir,
		resolveWebDir,
		resolveRuntimeDir,
	} = require("./util/paths.cjs");
	const seedDir = resolveKernelDir(
		app.isPackaged,
		process.resourcesPath,
		process.env,
	); // packaged=只读 seed；dev=repo 源码
	const webDir = resolveWebDir(
		app.isPackaged,
		process.resourcesPath,
		process.env,
	);
	const runtimeDir = resolveRuntimeDir(WA_PI_DIR); // WA_PI_DIR/runtime 可写（默认 ~/.pi/agent/runtime）
	// packaged 下 sidecar 是 bun --compile 编译产物 WaPiKernel（分发进程名不暴露 bun）；dev 仍用 host bun。
	const KERNEL_BIN =
		process.platform === "win32" ? "WaPiKernel.exe" : "WaPiKernel";
	const kernelExe = path.join(seedDir, KERNEL_BIN);
	// dev:desktop 与生产同形态：repo 内存在编译产物（packages/kernel/dist/WaPiKernel，
	// 由 bun run --filter @wa-pi/kernel build 产出）则直接 spawn；缺失时回退解释运行。
	let devKernelExe;
	if (!app.isPackaged) {
		const candidate = path.join(seedDir, "dist", KERNEL_BIN);
		if (fs.existsSync(candidate)) {
			devKernelExe = candidate;
		} else {
			log.info(
				`[kernel] 未找到编译产物 packages/kernel/dist/${KERNEL_BIN}，dev 回退解释运行；` +
					`如需与生产一致请先运行 bun run --filter @wa-pi/kernel build`,
			);
		}
	}

	// 2a) 启动清扫：清掉上轮异常退出残留的 kernel 登记（TTL 兜底 + 三重校验），
	// 避免残留进程继续占着 9778（Windows 升级后幽灵占用治理第一步；D 任务再完善自愈循环）。
	// dev 模式（electron .，app.isPackaged === false）跳过：sweepRegistry 的 isOurs 三重校验
	// 无法区分「dev 自己」与「正在运行的生产 kernel」——两者同在 ~/.pi/agent、同 exe 特征、
	// 创建时间一致（生产进程仍存活），会把生产 kernel 当残留杀掉。dev 的崩溃残留由上方
	// 端口自愈的「换端口」路径绕开（遇占用不杀进程），故 dev 无需杀伐式清扫。
	if (app.isPackaged) {
		try {
			const r = sweepRegistry(registryOpts);
			if (
				r.killed.length ||
				r.deleted.length ||
				r.skipped.length ||
				r.errors.length
			) {
				log.info(
					`[registry] 启动清扫: killed=[${r.killed.join(",") || "无"}] ` +
						`deleted=[${r.deleted.join(",") || "无"}] skipped=[${r.skipped.join(",") || "无"}] ` +
						`errors=[${r.errors.map((e) => `${e.pid}:${e.reason}`).join(";") || "无"}]`,
				);
			}
		} catch (e) {
			log.error("[registry] 启动清扫失败", e);
		}
	} else {
		log.info("[registry] dev 模式跳过启动清扫（避免误杀运行中的生产 kernel）");
	}

	// 2b) 固定端口：端口变化会导致前端 IndexedDB origin 改变（跨 origin 数据不可见），
	// 因此固定 FIXED_PORT，不再自动后移。被占用时先静默自愈（最多 3 轮：杀占用+登记簿清扫），
	// 自愈失败也静默自动换端口启动（不打扰用户，自动找可用端口 relaunch）。
	const actualPort = FIXED_PORT;
	// 自愈失败统一出口：不再弹错误页提示用户，而是静默自动换端口启动。
	// 自愈内部异常（taskkill ENOENT、fs 异常等）同样走这里——若直接抛出，whenReady 的
	// promise 链断裂、splash 永久卡在"正在自动清理…"，变成死端（全包无 unhandledRejection
	// 兜底，必须就地接住）。若换端口也找不到可用端口，才落回错误提示。
	const selfHealFailed = async (err) => {
		if (err) log.error(`端口 ${FIXED_PORT} 自动清理异常`, err);
		log.error(`端口 ${FIXED_PORT} 自愈失败，自动换端口启动`);
		const switched = await autoSwitchPortAndRelaunch();
		if (!switched) {
			log.error(`[port-switch] 未找到可用端口（从 ${FIXED_PORT + 1} 起）`);
			setProgress(-1, t("noPort"));
			splashWindow?.webContents
				?.executeJavaScript(
					"window.__showActions&&window.__showActions({quit:true})",
				)
				.catch(() => {});
		}
	};
	try {
		if (await isPortInUse(FIXED_PORT)) {
			// dev 模式（electron .，app.isPackaged === false）：9778 被占用很可能是
			// 已运行的生产/其他 wa-pi 实例（同在 ~/.pi/agent 数据目录、同为内核进程），
			// killPortOccupants 与 sweepRegistry 无法区分 dev/生产，会误杀生产。
			// 因此 dev 遇占用不杀进程，直接复用自愈兜底的「换端口启动」路径（自动找可用端口 relaunch）。
			if (!app.isPackaged) {
				log.info(`[dev] 端口 ${FIXED_PORT} 被占用，不清理占用进程，自动换端口启动`);
				setProgress(10, t("portOccupiedAutoSwitch"));
				await selfHealFailed();
				return;
			}
			log.error(`端口 ${FIXED_PORT} 被占用，尝试自动清理`);
			setProgress(10, t("portOccupiedAutoCleanup"));
			const healed = await attemptSelfHeal({
				rounds: 3,
				isPortInUse: () => isPortInUse(FIXED_PORT),
				killPortOccupants: () =>
					killPortOccupants(FIXED_PORT, undefined, (m) => log.info(m)),
				sweepRegistry: () => sweepRegistry(registryOpts),
				waitMs: 500,
				log: (m) => log.info(m),
			});
			if (!healed.healed) {
				log.error(`端口 ${FIXED_PORT} 自愈失败，自动换端口启动`);
				await selfHealFailed();
				return;
			}
			log.info(`端口 ${FIXED_PORT} 自动清理成功`);
		}
	} catch (e) {
		// 自愈路径异常兜底（isPortInUse/killPortOccupants/sweepRegistry 裸调可能抛）：
		// 转成静默自动换端口，不让 splash 卡死
		await selfHealFailed(e);
		return;
	}
	log.info(`kernel 端口固定为 ${actualPort}`);

	// 阶段边界：进入「运行时准备」（node 检测 + 依赖安装 + bin 链接）之前
	startup.mark("runtimeReadyStart");

	// 2b+) 首启 Node.js 运行时检测/下载（packaged）。
	// 打包版只捆绑 bun，但 MCP 服务器（npx -y <package>）等场景需要真实 node + npm。
	// 无系统 node 时自动下载 node LTS（IP 检测选源：国内 npmmirror，国外 nodejs.org）。
	let nodeExe = null;
	let nodeDir = null;
	if (app.isPackaged) {
		try {
			const { ensureNodeRuntime } = require("./util/node-runtime.cjs");
			setProgress(8, t("detectingNode"));
			nodeExe = await ensureNodeRuntime({
				waPiDir: WA_PI_DIR,
				log,
				onStatus: (t) => setProgress(10, t),
			});
			if (nodeExe) {
				nodeDir = path.dirname(nodeExe);
				log.info(`[node-runtime] 使用 Node.js: ${nodeExe}`);
			}
		} catch (e) {
			log.error("[node-runtime] Node.js 检测/下载失败", e);
		}
	}

	// 2c) 首启依赖检测/动态安装（packaged：WA_PI_DIR/runtime 下用阿里源装原生 addon 等）
	let runDir = seedDir;
	if (app.isPackaged) {
		const { ensureRuntimeDeps } = require("./util/runtime-deps.cjs");
		setProgress(15, t("preparingDeps"));
		let ip = 15;
		const installTrickle = setInterval(() => {
			ip = Math.min(80, ip + 3);
			setProgress(ip, t("downloadingDeps"));
		}, 2000);
		try {
			runDir = await ensureRuntimeDeps({
				isPackaged: true,
				seedDir,
				runtimeDir,
				kernelExe,
				version: app.getVersion(),
				log,
				onStatus: (t) => setProgress(ip, t),
			});
		} catch (e) {
			clearInterval(installTrickle);
			log.error("依赖安装失败", e);
			setProgress(-1, t("depsInstallFailed"));
			mainWindow.webContents.once("did-finish-load", revealMainWindow);
			const detail = String(e.message || e).replace(/</g, "&lt;");
			mainWindow.loadURL(
				"data:text/html;charset=utf-8," +
					encodeURIComponent(
						`<body style='font-family:system-ui;padding:48px;color:#a00'>
<h2>${t("depsInstallFailedTitle")}</h2>
<p style='color:#444'>${t("depsInstallFailedDesc")}</p>
<pre style='color:#888;font-size:12px;white-space:pre-wrap'>${detail}</pre>
<div style='margin-top:24px'>
<button id='retry' style='font-size:16px;padding:8px 24px;margin-right:12px'>${t("retry")}</button>
<button id='quit' style='font-size:16px;padding:8px 24px'>${t("quit")}</button>
</div>
<script>
const btn = document.getElementById('retry');
btn.onclick = () => { btn.disabled = true; btn.textContent = '${t("restarting")}'; window.waPiApp.retryInstall(); };
document.getElementById('quit').onclick = () => window.waPiApp.quit();
</script>
</body>`,
					),
			);
			return;
		}
		clearInterval(installTrickle);
	}

	// 2c+) 为 packaged 运行环境补充 bun/node 命令，供动态插件安装/运行 npm 包工具。
	// 打包版只有 WaPiKernel（编译产物），部分 npm 包脚本的 shebang 需要 node。
	if (app.isPackaged) {
		try {
			const { ensureRuntimeBinLinks } = require("./util/runtime-bin.cjs");
			const binDir = await ensureRuntimeBinLinks({
				kernelExe,
				waPiDir: WA_PI_DIR,
				log,
				nodeExe,
				isPackaged: true,
			});
			if (binDir) {
				const sep = process.platform === "win32" ? ";" : ":";
				// 追加 binDir 和 nodeDir（下载的 node 自带 npm/npx 需要 PATH）
				const extraPaths = [binDir];
				if (nodeDir) extraPaths.push(nodeDir);
				process.env.PATH = (process.env.PATH || "") + sep + extraPaths.join(sep);
				log.info(`[runtime-bin] PATH 追加 ${extraPaths.join(sep)}`);
			}
		} catch (e) {
			log.error("[runtime-bin] 创建符号链接失败", e);
		}
	}

	// 阶段边界：「运行时准备」结束（node 检测 + 依赖安装 + bin 链接全部完成）
	startup.mark("runtimeReadyDone");

	// 2c++) 预览独立窗口（浮动模式的承载窗口）。
	// 浮动预览不再是主窗口内的 DOM 浮层，而是真正的系统窗口（能移出主窗口、与主窗口并行显示）。
	// 窗口加载同一份前端（同端口同源，保证 localStorage/IndexedDB 与 API 相对路径可用），
	// 前端按 query 分流为「预览窗口模式」；预览内容仍是窗口内的同源 iframe，
	// 所以 inspect（高亮/锁定/选中）的 postMessage 协议零改动。
	const PREVIEW_MIN_W = 320;
	const PREVIEW_MIN_H = 240;
	/** 主窗口下行消息（独立窗口的全部事件都经主窗口中转处理，两个渲染进程不直连） */
	const sendToMain = (payload) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("previewwin:event", payload);
		}
	};
	/** 无历史记录时的默认摆放：相对主窗口偏移，避免完全遮盖主窗口 */
	const defaultPreviewBounds = () => {
		const b =
			mainWindow && !mainWindow.isDestroyed()
				? mainWindow.getBounds()
				: { x: 80, y: 80, width: 1280, height: 860 };
		return { x: b.x + 64, y: b.y + 64, width: 900, height: 700 };
	};
	const createPreviewWindow = (payload = {}) => {
		// 单例：已存在则只同步最新预览内容（主窗口切会话/切文件后不显示陈旧内容），
		// 最小化态下不打扰（仅同步），可见时才聚焦
		if (previewWindow && !previewWindow.isDestroyed()) {
			previewWindow.webContents.send("previewwin:event", {
				type: "sync",
				path: payload.path ?? null,
				sessionId: payload.sessionId ?? null,
			});
			if (previewWindow.isVisible()) previewWindow.focus();
			return { ok: true };
		}
		const rect = payload.rect;
		const bounds =
			rect && [rect.x, rect.y, rect.w, rect.h].every((n) => Number.isFinite(n))
				? {
						x: Math.round(rect.x),
						y: Math.round(rect.y),
						width: Math.round(rect.w),
						height: Math.round(rect.h),
					}
				: defaultPreviewBounds();
		previewWindow = new BrowserWindow({
			...bounds,
			minWidth: PREVIEW_MIN_W,
			minHeight: PREVIEW_MIN_H,
			// 无边框自绘：拖动区由前端工具栏承担（-webkit-app-region: drag），缩放靠右下角自绘手柄
			frame: false,
			show: false, // 等前端首帧渲染完成（act: ready）后再显示，避免白屏
			backgroundColor: CANVAS_BG,
			icon: path.join(__dirname, "assets", "icon.ico"),
			// sandbox:false：preload 需 require('electron').clipboard 注入 waPiClipboard（sandbox 下该模块不在白名单，会导致复制失效）
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: false,
				preload: path.join(__dirname, "preload.cjs"),
			},
		});
		const win = previewWindow;
		const params = new URLSearchParams({ "wa-preview-win": "1" });
		if (payload.path) params.set("path", String(payload.path));
		if (payload.sessionId) params.set("sid", String(payload.sessionId));
		win.loadURL(`http://127.0.0.1:${actualPort}/?${params.toString()}`);
		// 位置/尺寸变化回报主窗口持久化（拖动中连续触发 → 防抖合并）
		let rectTimer = null;
		const reportRect = () => {
			if (rectTimer) clearTimeout(rectTimer);
			rectTimer = setTimeout(() => {
				rectTimer = null;
				if (!previewWindow || previewWindow.isDestroyed()) return;
				const b = previewWindow.getBounds();
				sendToMain({
					type: "rect",
					rect: { x: b.x, y: b.y, w: b.width, h: b.height },
				});
			}, 300);
		};
		win.on("moved", reportRect);
		win.on("resized", reportRect);
		win.on("closed", () => {
			if (rectTimer) clearTimeout(rectTimer);
			if (win === previewWindow) previewWindow = null;
			sendToMain({ type: "closed" });
		});
		return { ok: true };
	};
	// 独立窗口上报的动作：窗口开关在主进程执行，状态变更转发主窗口（状态的权威在渲染层 store）
	const handlePreviewAct = (payload) => {
		const type = payload?.type;
		if (!previewWindow || previewWindow.isDestroyed()) return;
		switch (type) {
			case "ready":
				if (!previewWindow.isVisible()) previewWindow.show();
				return;
			case "minimize": // 最小化 = 隐藏窗口，主窗口据此渲染气泡（点气泡恢复）
				previewWindow.hide();
				sendToMain({ type: "minimized" });
				return;
			case "close": // 关闭预览：关窗 + 主窗口 closeBrowser（清该会话预览记忆）
				previewWindow.close();
				sendToMain({ type: "close" });
				return;
			case "mode": // 独立窗口内切回内嵌（分屏/全屏）：关窗 + 主窗口切换模式
				previewWindow.close();
				sendToMain({ type: "mode", mode: payload.mode });
				return;
			case "element": // 选中元素：转发到主窗口插入聊天输入框
				sendToMain({ type: "element", token: String(payload.token ?? "") });
				return;
			case "path": // 独立窗口里换了预览文件：同步给主窗口（切回内嵌时恢复同一内容）
				sendToMain({ type: "path", path: payload.path ?? null });
				return;
			case "open-settings": // 设置弹窗只在主窗口（数据/上下文都在那边）：转发并把主窗口带到前台
				sendToMain({
					type: "open-settings",
					section: String(payload.section ?? "general"),
				});
				if (mainWindow && !mainWindow.isDestroyed()) {
					if (mainWindow.isMinimized()) mainWindow.restore();
					mainWindow.show();
					mainWindow.focus();
				}
				return;
			default:
				return;
		}
	};
	// 只接受主窗口的开窗请求（独立窗口自身不得再开窗，防递归）
	ipcMain.handle("previewwin:open", (event, payload) => {
		if (!mainWindow || event.sender !== mainWindow.webContents) {
			return { ok: false, reason: "forbidden" };
		}
		return createPreviewWindow(payload || {});
	});
	// 主窗口 → 独立窗口的窗口指令（关闭/恢复显示）
	ipcMain.on("previewwin:cmd", (event, payload) => {
		if (!mainWindow || event.sender !== mainWindow.webContents) return;
		if (!previewWindow || previewWindow.isDestroyed()) return;
		switch (payload?.type) {
			case "close":
				previewWindow.close();
				return;
			case "restore": // 点气泡恢复：显示并聚焦
				previewWindow.show();
				previewWindow.focus();
				return;
			default:
				return;
		}
	});
	ipcMain.on("previewwin:act", (event, payload) => {
		if (!previewWindow || event.sender !== previewWindow.webContents) return;
		handlePreviewAct(payload);
	});
	// 右下角缩放手柄：只改宽高，窗口左上角不动
	ipcMain.on("previewwin:set-size", (event, payload) => {
		if (!previewWindow || event.sender !== previewWindow.webContents) return;
		const w = Math.round(Number(payload?.w));
		const h = Math.round(Number(payload?.h));
		if (!Number.isFinite(w) || !Number.isFinite(h)) return;
		const b = previewWindow.getBounds();
		previewWindow.setBounds({
			x: b.x,
			y: b.y,
			width: Math.max(PREVIEW_MIN_W, w),
			height: Math.max(PREVIEW_MIN_H, h),
		});
	});

	// 阶段边界：调用 startSidecar（spawn 内核 + 等端口就绪）之前
	startup.mark("kernelSpawnStart");

	// 2d) 启动内核（packaged 从 runtimeDir 跑；dev 从源码跑）
	setProgress(85, t("startingKernel"));
	let kp = 85;
	const trickle = setInterval(() => {
		kp = Math.min(95, kp + 4);
		setProgress(kp, t("startingKernel"));
	}, 1500);
	try {
		sidecar = await startSidecar({
			isPackaged: app.isPackaged,
			kernelDir: runDir,
			webDir,
			kernelExe,
			devKernelExe,
			log,
			port: actualPort,
		});
		startup.mark("kernelReady");
		// 登记 kernel 进程（createdAt 用 sidecar 返回的 spawn 时刻：进程真实创建时刻，
		// 而非 startSidecar 等端口就绪后的时刻——启动耗时 >2s 时后者会让下轮清扫的
		// isOurs 时间一致性校验误判 PID 复用，登记簿核心目标静默失效）
		try {
			registerProcess(
				sidecar.pid,
				{ exe: kernelExe, createdAt: sidecar.createdAt },
				registryOpts,
			);
		} catch (e) {
			log.error("[registry] 登记 kernel 进程失败", e);
		}
		clearInterval(trickle);
		setProgress(98, t("loadingInterface"));
		// 内核页面渲染完成 → 关启动页、显示主窗口
		mainWindow.webContents.once("did-finish-load", () => {
			startup.mark("didFinishLoad");
			setProgress(100, t("ready"));
			// 首次出帧探测：能从渲染进程拿到一帧 rAF 回值，说明合成器确实在出帧
			// （之前这一段完全无日志，是「启动很久才渲染出界面」的定位盲区）。
			mainWindow.webContents
				.executeJavaScript(
					"new Promise(r=>requestAnimationFrame(()=>r(Math.round(performance.now()))))",
				)
				.then(() => {
					startup.mark("firstFrame");
					log.info(
						`[startup] 主进程模块加载起点=+${BOOT_OFFSET_MS}ms ${startup.summary()}`,
					);
				})
				.catch(() =>
					log.info(
						`[startup] 首帧探测失败 主进程模块加载起点=+${BOOT_OFFSET_MS}ms ${startup.summary()}`,
					),
				);
			revealMainWindow();
		});
		// 主窗口渲染进程异常：卡死/崩溃/加载失败都要留痕（否则表现为「白窗口卡住」）
		mainWindow.webContents.on("unresponsive", () =>
			log.error("[startup] 主窗口渲染进程无响应（界面卡死）"),
		);
		mainWindow.webContents.on("render-process-gone", (_e, d) =>
			log.error(`[startup] 主窗口渲染进程退出: ${JSON.stringify(d)}`),
		);
		mainWindow.webContents.on(
			"did-fail-load",
			(_e, code, desc, url) =>
				log.error(`[startup] 主窗口页面加载失败 code=${code} ${desc} ${url}`),
		);
		startup.mark("loadURL");
		mainWindow.loadURL(`http://127.0.0.1:${actualPort}`);
	} catch (e) {
		clearInterval(trickle);
		log.error("kernel 启动失败", e);
		// 错误：切到主窗口显示（主窗口带标题栏可关闭/重试），启动页退出
		setProgress(-1, t("kernelStartFailed"));
		mainWindow.webContents.once("did-finish-load", revealMainWindow);
		mainWindow.loadURL(
			"data:text/html;charset=utf-8,<body style='font-family:system-ui;padding:48px;color:#a00'>" +
				t("kernelStartFailed") +
				": " +
				String(e.message || e) +
				"</body>",
		);
	}
});

async function cleanup() {
	log.info("退出清理");
	try {
		if (sidecar) sidecar.stop();
	} catch {}
	// best-effort 自删：进程退出时清掉登记，避免残留（即使自删失败，下次启动清扫也会兜底）
	try {
		if (sidecar) unregisterProcess(sidecar.pid, registryOpts);
	} catch {}
	await log.flush();
}
app.on("before-quit", () => {
	isQuitting = true;
	cleanup();
	if (isUpdating) return;
	// 兜底清扫：清登记簿里我方残留（如运行期 kernel 重启换了 pid、或自删登记失败）。
	// sweepRegistry 全程同步（loadRegistry/三重校验/杀伐均为 sync + spawnSync），
	// 在同步监听器里直接调用即同步杀完——杀进程是 spawnSync 阻塞完成的，
	// 不存在“调了 async 不 await 就退出导致没杀到”的窗口（cleanup 里 sidecar.stop 同样同步阻塞）。
	try {
		const r = sweepRegistry(registryOpts);
		if (
			r.killed.length ||
			r.deleted.length ||
			r.skipped.length ||
			r.errors.length
		) {
			log.info(
				`[registry] 退出兜底清扫: killed=[${r.killed.join(",") || "无"}] ` +
					`deleted=[${r.deleted.join(",") || "无"}] skipped=[${r.skipped.join(",") || "无"}] ` +
					`errors=[${r.errors.map((e) => `${e.pid}:${e.reason}`).join(";") || "无"}]`,
			);
		}
	} catch (e) {
		log.error("[registry] 退出兜底清扫失败", e);
	}
});

// 窗口关闭 → 隐藏到托盘；保持后台运行（真正退出时不阻止）
app.on("window-all-closed", (event) => {
	if (!isQuitting) event.preventDefault();
});

// macOS 点 Dock 图标 / 重新激活时恢复窗口
app.on("activate", () => {
	if (kernelReady && mainWindow) activateApp();
	else if (splashWindow) activateApp();
	else createWindow();
});

process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
