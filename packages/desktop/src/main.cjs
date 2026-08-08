// Electron main：启动页(splash) + kernel sidecar + BrowserWindow + 生命周期 + 退出清理。
const {
	app,
	BrowserWindow,
	Menu,
	session,
	desktopCapturer,
	ipcMain,
} = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createLogger } = require("./util/log.cjs");
const { isPortInUse, killPortOccupants } = require("./util/port.cjs");

const WA_PI_DIR =
	process.env.WA_PI_DIR || path.join(os.homedir(), ".wa-pi");
const log = createLogger(path.join(WA_PI_DIR, "logs", "desktop.log"));

// 与前端 --canvas 对齐：主窗口/启动页用同色底，消除首帧白屏闪烁
const CANVAS_BG = "#F5F5F7";
const BRAND_GREEN = "#4BA26F";

let splashWindow = null;
let mainWindow = null;
let sidecar = null;
let isQuitting = false;
// kernel 固定端口：端口变化会导致前端 IndexedDB origin 改变（跨 origin 数据不可见），
// 因此固定端口，被占用时由启动页「重启应用」一键清理
const FIXED_PORT = Number(process.env.WA_PI_WS_PORT) > 0 ? Number(process.env.WA_PI_WS_PORT) : 9778;
// 内核是否就绪（mainWindow 是否已加载真实页面）。未就绪时点托盘/Dock 应聚焦启动页，而非弹出空白主窗口。
let kernelReady = false;

// 启动页 HTML：logo 内联成 base64（规避 file:// 与 asar 路径差异），整页走 data: URL 即时渲染、不闪屏。
function buildSplashURL() {
	const logoPath = path.join(__dirname, "assets", "icon.png");
	const logoB64 = fs.existsSync(logoPath)
		? fs.readFileSync(logoPath).toString("base64")
		: "";
	const logoSrc = logoB64 ? `data:image/png;base64,${logoB64}` : "";
	const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:${CANVAS_BG};display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1d1d1f;user-select:none;overflow:hidden;-webkit-app-region:drag}
.logo{width:96px;height:96px;border-radius:22px;box-shadow:0 8px 24px rgba(0,0,0,.12);margin-bottom:24px}
.name{font-size:20px;font-weight:600;letter-spacing:.5px;margin-bottom:34px}
.bar{width:200px;height:4px;border-radius:99px;background:#e5e5ea;overflow:hidden}
.fill{height:100%;width:8%;border-radius:99px;background:${BRAND_GREEN};transition:width .45s cubic-bezier(.4,0,.2,1)}
.status{margin-top:16px;font-size:12px;color:#86868b;min-height:16px;text-align:center;padding:0 24px}
.err{color:#d9404d}
#restart-btn{display:none;margin-top:20px;padding:8px 20px;border:0;border-radius:8px;background:${BRAND_GREEN};color:#fff;font-size:13px;font-weight:600;cursor:pointer;-webkit-app-region:no-drag}
#restart-btn:active{opacity:.85}
</style></head><body>
${logoSrc ? `<img class="logo" src="${logoSrc}" alt="WA PI Agent"/>` : `<div class="logo" style="background:${BRAND_GREEN}"></div>`}
<div class="name">WA PI Agent</div>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="status" id="status">正在启动…</div>
<button id="restart-btn" type="button">重启应用</button>
<script>
window.__setProgress=function(p,t){var f=document.getElementById('fill');if(f)f.style.width=Math.max(5,Math.min(100,p))+'%';var s=document.getElementById('status');if(s){if(t){s.textContent=t;s.className='status';}if(p<0){s.className='status err';}}};
window.__showRestart=function(){var b=document.getElementById('restart-btn');if(b)b.style.display='block';};
document.getElementById('restart-btn').addEventListener('click',function(){this.disabled=true;this.textContent='正在重启…';if(window.waPiApp)window.waPiApp.restartAfterPortKill();});
</script>
</body></html>`;
	return "data:text/html;charset=utf-8," + encodeURIComponent(html);
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
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, "preload.cjs") },
	});
	splashWindow.loadURL(buildSplashURL());
	splashWindow.on("closed", () => {
		splashWindow = null;
	});
}

// packaged 下运行时只有 wa-pi-kernel(=bun)，PATH 上缺少 node/npm/bun/npx。
// 动态插件可能需要 bun 来装 npm 包，装好的 bin 脚本 shebang 又需要 node。
// 因此在 ~/.wa-pi/bin 下创建 bun / node 符号链接指向 wa-pi-kernel，
// 并把该目录追加到 sidecar 的 PATH。
// npx 需要特殊处理：bun x 等价于 npx，创建包装脚本去除 -y/--yes（bun x 自动确认）。
// node：优先搜索系统真实 Node.js（MCP 服务器大多是 Node 包，bun 不完全兼容），
// 找不到才回退到 wa-pi-kernel。

/** 搜索系统上的真实 Node.js 安装路径 */
function findSystemNode() {
	const candidates =
		process.platform === "win32"
			? [
				path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
			]
			: [
				"/opt/homebrew/bin/node",       // Apple Silicon Homebrew
				"/usr/local/bin/node",           // Intel Homebrew / manual install
				"/usr/bin/node",                 // Xcode CLT / system
			];
	// also check common nvm paths
	const home = os.homedir();
	const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
	try {
		const versionsDir = path.join(nvmDir, "versions", "node");
		if (fs.existsSync(versionsDir)) {
			const versions = fs.readdirSync(versionsDir).sort().reverse();
			for (const v of versions) {
				const p = path.join(versionsDir, v, "bin", "node");
				if (fs.existsSync(p)) candidates.push(p);
			}
		}
	} catch {}
	// fnm
	try {
		const fnmDir = process.env.FNM_DIR || path.join(home, ".fnm");
		if (fs.existsSync(fnmDir)) {
			const aliasDefault = path.join(fnmDir, "aliases", "default");
			if (fs.existsSync(aliasDefault)) {
				const ver = fs.readFileSync(aliasDefault, "utf8").trim();
				const p = path.join(fnmDir, "node-versions", ver, "installation", "bin", "node");
				if (fs.existsSync(p)) candidates.push(p);
			}
		}
	} catch {}
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

async function ensureRuntimeBinLinks({ runtimeDir, seedDir, kernelExe, waPiDir, log }) {
	if (!app.isPackaged) return null;
	const binDir = path.join(waPiDir, "bin");
	// 使用 seedDir 中的真实内核二进制路径（wa-pi-kernel 不会被复制到 runtimeDir）
	const target = kernelExe;
	await fsp.mkdir(binDir, { recursive: true });
	if (process.platform === "win32") {
		// Windows 下符号链接需要权限/开发模式，改用 .cmd 包装脚本
		const t = target;
		await fsp.writeFile(path.join(binDir, "npx.cmd"), `@echo off\r\n"${t}" x %*\r\n`);
		await fsp.writeFile(path.join(binDir, "bun.cmd"), `@echo off\r\n"${t}" %*\r\n`);
		const sysNode = findSystemNode();
		if (sysNode) {
			await fsp.writeFile(path.join(binDir, "node.cmd"), `@echo off\r\n"${sysNode}" %*\r\n`);
			log.info(`[runtime-bin] Windows node.cmd -> ${sysNode} (system)`);
		} else {
			await fsp.writeFile(path.join(binDir, "node.cmd"), `@echo off\r\n"${t}" %*\r\n`);
			log.info(`[runtime-bin] Windows node.cmd -> ${t} (bun fallback)`);
		}
		await fsp.writeFile(path.join(binDir, "npm.cmd"), `@echo off\r\nif /i "%~1"=="exec" (shift & "${t}" x %*) else "${t}" %*\r\n`);
		log.info(`[runtime-bin] Windows: npx/bun/node/npm.cmd -> ${t}`);
		return binDir;
	}
	const bunLink = path.join(binDir, "bun");
	const nodeLink = path.join(binDir, "node");
	const npxPath = path.join(binDir, "npx");
	const npmPath = path.join(binDir, "npm");
	await fsp.rm(bunLink, { force: true });
	await fsp.rm(nodeLink, { force: true });
	await fsp.rm(npxPath, { force: true });
	await fsp.rm(npmPath, { force: true });
	await fsp.symlink(target, bunLink);
	// node：优先系统真实 Node.js，MCP 服务器通常是 Node 包需要原生支持
	const systemNode = findSystemNode();
	if (systemNode) {
		await fsp.symlink(systemNode, nodeLink);
		log.info(`[runtime-bin] node -> ${systemNode} (system)`);
	} else {
		await fsp.symlink(target, nodeLink);
		log.info(`[runtime-bin] node -> ${target} (bun fallback)`);
	}
	// npx 包装脚本：直接透传到 bun x（bun x 自动确认安装，忽略 -y/--yes）
	const npxScript = `#!/bin/sh
exec "${target}" x "\$@"
`;
	await fsp.writeFile(npxPath, npxScript);
	await fsp.chmod(npxPath, 0o755);
	// npm exec -> bun x wrapper
	const npmScript = `#!/bin/sh
if [ "\$1" = "exec" ]; then shift; exec "${target}" x "\$@"; fi
exec "${target}" "\$@"
`;
	await fsp.writeFile(npmPath, npmScript);
	await fsp.chmod(npmPath, 0o755);
	log.info(`[runtime-bin] bun/node/npx/npm -> ${target}`);
	return binDir;
}

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
		backgroundColor: CANVAS_BG,
		icon: path.join(__dirname, "assets", "icon.ico"),
		// sandbox:false：preload 需 require('electron').clipboard 注入 waPiClipboard（sandbox 下该模块不在白名单，会导致复制失效）
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, "preload.cjs") },
	});
	// 点关闭按钮 → 最小化到托盘，不退出
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			event.preventDefault();
			mainWindow.hide();
			if (process.platform === "darwin") app.dock.hide();
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	// 调试：F12 / Cmd+Alt+I 打开 DevTools（打包态排查持久化等问题）
	mainWindow.webContents.on("before-input-event", (_event, input) => {
		if (input.type !== "keyDown") return;
		if (input.key === "F12" || ((input.control || input.meta) && input.alt && input.key.toLowerCase() === "i")) {
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
// 实测（ProcessExplorer / 任务管理器）：本机 WA PI Agent 全部进程 GPU 占用为 0，
// 即 Electron 内置 Chromium 未启用 GPU 合成、完全走 CPU 软件渲染，导致滚动/交互相对于
// 独立 Chrome 浏览器明显掉帧。本机为 NVIDIA dGPU + Intel iGPU 双显卡笔记本，Electron 43
// 默认未正确激活硬件加速。以下 switches 强制启用 GPU 光栅化并指定 ANGLE(D3D11) 后端
// （Win 上最稳定），并对齐浏览器的合成路径。
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("use-angle", "d3d11");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

app.whenReady().then(async () => {
	// GPU 信息取证：记录实际 GPU 后端，便于确认合成是否走了硬件加速（vs 软件渲染）。
	app.getGPUInfo("complete")
		.then((info) => log.info("GPU 信息:", JSON.stringify(info?.gpuDevice ?? info?.auxAttributes ?? {}, null, 0)))
		.catch(() => {});
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
	setProgress(10, "正在初始化…");
	createWindow();

	// 自动更新：系统设置 → 关于（Gitee Releases + electron-updater）
	// WA_PI_UPDATER_* env 仅供 E2E/测试指向本地 mock，生产默认走 https://gitee.com/api/v5
	const { setupUpdater } = require("./updater/updater.cjs");
	setupUpdater({
		getMainWindow: () => mainWindow,
		log: (m) => log.info(m),
		isPackaged: app.isPackaged,
		currentVersion: app.getVersion(),
		config: {
			baseUrl: process.env.WA_PI_UPDATER_BASE_URL || undefined,
			owner: process.env.WA_PI_UPDATER_OWNER || undefined,
			repo: process.env.WA_PI_UPDATER_REPO || undefined,
		},
	});

	// 端口被占用时启动页「重启应用」按钮的处理：杀掉占用 9778 的进程后重启本应用
	ipcMain.handle("app:restart-after-port-kill", async () => {
		const pids = await killPortOccupants(FIXED_PORT, undefined, (m) => log.info(m));
		log.info(`[port-kill] 端口 ${FIXED_PORT} 占用进程已清理: ${pids.join(", ") || "(无)"}`);
		// 短暂等待端口真正释放
		await new Promise((r) => setTimeout(r, 500));
		// 清理后仍占用：幽灵句柄由无我方特征的进程持有（如 agent 帮用户起的 dev server），
		// 自动清理无能为力——诚实提示，不再 relaunch 进同一个死循环
		if (await isPortInUse(FIXED_PORT)) {
			log.error(`[port-kill] 端口 ${FIXED_PORT} 清理后仍被占用，放弃重启`);
			setProgress(-1, `端口 ${FIXED_PORT} 仍被占用，自动清理失败。请在任务管理器中结束残留的 bun / wa-pi 进程，或重启电脑后再试。`);
			return;
		}
		app.relaunch();
		app.exit(0);
	});

	// 托盘 + 菜单
	const { startTray } = require("./tray.cjs");
	const trayIconName =
		process.platform === "darwin"
			? "tray_darwin.png"
			: process.platform === "win32"
				? "tray_windows.ico"
				: "tray_linux.png";
	startTray({
		iconPath: path.join(__dirname, "assets", trayIconName),
		onOpen: activateApp,
		onQuit: () => app.quit(),
	});
	const { buildAppMenuTemplate } = require("./util/menu.cjs");
	if (process.platform === "darwin") {
		Menu.setApplicationMenu(
			Menu.buildFromTemplate(buildAppMenuTemplate(app.name)),
		);
	} else {
		Menu.setApplicationMenu(null);
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
	const runtimeDir = resolveRuntimeDir(WA_PI_DIR); // ~/.wa-pi/runtime 可写
	// packaged 下 sidecar 二进制已重命名为 wa-pi-kernel（分发进程名不暴露 bun）；dev 仍用 host bun。
	const kernelExe = path.join(
		seedDir,
		process.platform === "win32" ? "wa-pi-kernel.exe" : "wa-pi-kernel",
	);

	// 2a) 固定端口：端口变化会导致前端 IndexedDB origin 改变（跨 origin 数据不可见），
	// 因此固定 FIXED_PORT，不再自动后移。被占用时在启动页提示并提供「重启应用」一键杀占用+重启。
	const actualPort = FIXED_PORT;
	if (await isPortInUse(FIXED_PORT)) {
		log.error(`端口 ${FIXED_PORT} 被占用，等待用户在启动页点击重启`);
		setProgress(-1, `端口 ${FIXED_PORT} 被占用，可能是上次未正常退出。点击下方按钮自动清理并重启。`);
		splashWindow?.webContents?.executeJavaScript("window.__showRestart&&window.__showRestart()").catch(() => {});
		return;
	}
	log.info(`kernel 端口固定为 ${actualPort}`);

	// 2a) 首启依赖检测/动态安装（packaged：~/.wa-pi/runtime 下用阿里源装原生 addon 等）
	let runDir = seedDir;
	if (app.isPackaged) {
		const { ensureRuntimeDeps } = require("./util/runtime-deps.cjs");
		setProgress(15, "正在准备依赖…");
		let ip = 15;
		const installTrickle = setInterval(() => {
			ip = Math.min(80, ip + 3);
			setProgress(ip, "正在下载依赖…");
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
			setProgress(-1, "依赖安装失败，请检查网络后重启");
			mainWindow.webContents.once("did-finish-load", revealMainWindow);
			mainWindow.loadURL(
				"data:text/html;charset=utf-8,<body style='font-family:system-ui;padding:48px;color:#a00'>内核依赖安装失败，请检查网络连接后重启 WA PI Agent。<br/><br/>详情：" +
					String(e.message || e).replace(/</g, "&lt;") +
					"</body>",
			);
			return;
		}
		clearInterval(installTrickle);
	}

	// 2a+) 为 packaged 运行环境补充 bun/node 命令，供动态插件安装/运行 npm 包工具。
	// 打包版只有 wa-pi-kernel(=bun)，部分 npm 包脚本的 shebang 需要 node。
	if (app.isPackaged) {
		try {
			const binDir = await ensureRuntimeBinLinks({
				runtimeDir,
				seedDir,
				kernelExe,
				waPiDir: WA_PI_DIR,
				log,
			});
			if (binDir) {
				const sep = process.platform === "win32" ? ";" : ":";
				process.env.PATH = (process.env.PATH || "") + sep + binDir;
				log.info(`[runtime-bin] PATH 追加 ${binDir}`);
			}
		} catch (e) {
			log.error("[runtime-bin] 创建符号链接失败", e);
		}
	}

	// 2b) 启动内核（packaged 从 runtimeDir 跑；dev 从源码跑）
	setProgress(85, "正在启动内核…");
	let kp = 85;
	const trickle = setInterval(() => {
		kp = Math.min(95, kp + 4);
		setProgress(kp, "正在启动内核…");
	}, 1500);
	try {
		sidecar = await startSidecar({
			isPackaged: app.isPackaged,
			kernelDir: runDir,
			webDir,
			kernelExe,
			log,
			port: actualPort,
		});
		clearInterval(trickle);
		setProgress(98, "正在加载界面…");
		// 内核页面渲染完成 → 关启动页、显示主窗口
		mainWindow.webContents.once("did-finish-load", () => {
			setProgress(100, "就绪");
			revealMainWindow();
		});
		mainWindow.loadURL(`http://127.0.0.1:${actualPort}`);
	} catch (e) {
		clearInterval(trickle);
		log.error("kernel 启动失败", e);
		// 错误：切到主窗口显示（主窗口带标题栏可关闭/重试），启动页退出
		setProgress(-1, "内核启动失败");
		mainWindow.webContents.once("did-finish-load", revealMainWindow);
		mainWindow.loadURL(
			"data:text/html;charset=utf-8,<body style='font-family:system-ui;padding:48px;color:#a00'>内核启动失败：" +
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
	await log.flush();
}
app.on("before-quit", () => {
	isQuitting = true;
	cleanup();
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
