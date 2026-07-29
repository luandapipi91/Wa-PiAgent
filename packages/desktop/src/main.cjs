// Electron main：启动页(splash) + kernel sidecar + BrowserWindow + 生命周期 + 退出清理。
const {
	app,
	BrowserWindow,
	Menu,
	session,
	desktopCapturer,
} = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createLogger } = require("./util/log.cjs");
const { findAvailablePort } = require("./util/port.cjs");

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
.status{margin-top:16px;font-size:12px;color:#86868b;min-height:16px;text-align:center}
.err{color:#d9404d}
</style></head><body>
${logoSrc ? `<img class="logo" src="${logoSrc}" alt="WA PI Agent"/>` : `<div class="logo" style="background:${BRAND_GREEN}"></div>`}
<div class="name">WA PI Agent</div>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="status" id="status">正在启动…</div>
<script>
window.__setProgress=function(p,t){var f=document.getElementById('fill');if(f)f.style.width=Math.max(5,Math.min(100,p))+'%';var s=document.getElementById('status');if(s){if(t){s.textContent=t;s.className='status';}if(p<0){s.className='status err';}}};
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
		webPreferences: { nodeIntegration: false, contextIsolation: true },
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
		webPreferences: { nodeIntegration: false, contextIsolation: true },
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

app.whenReady().then(async () => {
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

	// 2a) 探测可用端口：默认/配置端口被占用时自动后移
	const desiredPort =
		Number(process.env.WA_PI_WS_PORT) > 0
			? Number(process.env.WA_PI_WS_PORT)
			: 9776;
	let actualPort;
	try {
		actualPort = await findAvailablePort(desiredPort);
		log.info(
			`选中 kernel 端口 ${actualPort}${actualPort === desiredPort ? "" : `（原 ${desiredPort} 被占用）`}`,
		);
	} catch (e) {
		log.error("未找到可用端口", e);
		setProgress(-1, "未找到可用端口，请关闭占用 9776 附近端口的程序后重试");
		return;
	}

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
