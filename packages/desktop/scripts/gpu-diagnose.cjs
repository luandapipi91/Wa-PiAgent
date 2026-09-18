// gpu-diagnose.cjs —— 打包版「启动卡顿（启动页空白/进度条停住/很久才出界面）」现场取证 demo。
//
// 为什么需要：四个强制 GPU 开关（enable-gpu-rasterization / enable-zero-copy /
// use-angle=d3d11 / ignore-gpu-blocklist）在 macOS 上会把 GPU 整个关掉（合成退化到软件渲染，
// 出帧 60fps → 6~16fps），已修。Windows 上 d3d11 是正确后端，但同样报「慢」，需要现场数据
// 判断是「加速没生效（软件渲染）」还是「某一开关把 GPU 打坏」，故做这个 A/B demo。
//
// 用法（需要 Electron 运行时，任选其一）：
//   A. 仓库里已装 electron：在 packages/desktop 下执行
//        node_modules\.bin\electron scripts\gpu-diagnose.cjs --variant=none
//        node_modules\.bin\electron scripts\gpu-diagnose.cjs --variant=prod
//   B. 有 node/npm 的临时目录：npm i -D electron@43 && npx electron gpu-diagnose.cjs --variant=prod
//   或直接跑 scripts\gpu-diagnose.cmd（自动跑两种配置并落盘 gpu-diagnose.log）
//
// 它只看不写：不连任何服务、不占端口、不读写本应用的数据目录，窗口几秒后自动关闭。
//
// 判定口径：
//   [GPU] 行出现「⚠️ 软件渲染」→ 硬件加速实际没生效（GPU 被关掉/被 blocklist 拦下）。
//   出帧（rAF）< 30fps 或「进度条走完宽度」< 190px → 合成路径退化，首帧被推迟（复现卡顿）。
const { app, BrowserWindow } = require("electron");

const arg = (k, dflt = "") =>
	(process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || dflt;
const variant = arg("variant", "prod");

// 与 packages/desktop/src/main.cjs 完全一致的一组开关
const PROD_SWITCHES = [
	["enable-gpu-rasterization"],
	["enable-zero-copy"],
	["use-angle", "d3d11"],
	["ignore-gpu-blocklist"],
];
if (variant === "prod") {
	for (const [k, v] of PROD_SWITCHES) {
		if (v) app.commandLine.appendSwitch(k, v);
		else app.commandLine.appendSwitch(k);
	}
}

const T0 = Date.now();
const BOOT_OFFSET_MS =
	typeof process.getCreationTime === "function" && process.getCreationTime()
		? Date.now() - process.getCreationTime()
		: 0;

// 与真实启动页同形的页面：进度条 200px + transition:width .45s（用户看到的「条子不动」就在这里）
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%}
body{background:#F5F5F7;display:flex;flex-direction:column;align-items:center;justify-content:center;
font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1d1d1f}
.logo{width:96px;height:96px;border-radius:22px;background:#4BA26F;margin-bottom:24px}
.name{font-size:20px;font-weight:600;margin-bottom:34px}
.bar{width:200px;height:4px;border-radius:99px;background:#e5e5ea;overflow:hidden}
.fill{height:100%;width:8%;border-radius:99px;background:#4BA26F;transition:width .45s cubic-bezier(.4,0,.2,1)}
.status{margin-top:16px;font-size:12px;color:#86868b;min-height:16px}
</style></head><body>
<div class="logo"></div><div class="name">WA PI Agent（GPU 诊断 demo）</div>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="status" id="status">正在启动…</div>
<script>window.__setProgress=function(p,t){var f=document.getElementById('fill');if(f)f.style.width=Math.max(5,Math.min(100,p))+'%';var s=document.getElementById('status');if(s&&t)s.textContent=t;};</script>
</body></html>`;

app.whenReady().then(async () => {
	const marks = { ready: Date.now() - T0 };
	const win = new BrowserWindow({
		width: 360, height: 440, frame: false, resizable: false, show: true,
		backgroundColor: "#F5F5F7",
	});
	marks.windowCreated = Date.now() - T0;
	win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
	await new Promise((r) => win.webContents.once("did-finish-load", r));
	marks.didFinishLoad = Date.now() - T0;

	const js = (code) => win.webContents.executeJavaScript(code);
	await js("1");
	marks.firstJsResponsive = Date.now() - T0;

	const paints = await js(
		"JSON.stringify(performance.getEntriesByType('paint').map(e=>[e.name,Math.round(e.startTime)]))",
	);
	const rafFps = await js(
		"new Promise(res=>{let n=0;const t0=performance.now();function f(){n++;const el=performance.now()-t0;if(el<1000)requestAnimationFrame(f);else res(Math.round(n*1000/el));}requestAnimationFrame(f);})",
	);

	// 用户症状的直接复现：设到「正在加载界面…」(98%) 后等 1.2s，看进度条是否真走到 ~196px
	await js("window.__setProgress(98,'正在加载界面…')");
	await new Promise((r) => setTimeout(r, 1200));
	const barWidth = await js("document.getElementById('fill').getBoundingClientRect().width");
	marks.measured = Date.now() - T0;

	// GPU 状态：feature status 看合成是否退化，gpuDevice 看是否真的激活
	let feature = {};
	try { feature = app.getGPUFeatureStatus(); } catch (e) { feature = { err: String(e.message) }; }
	let devices = [];
	try {
		const info = await app.getGPUInfo("complete");
		devices = (info && info.gpuDevice) || [];
	} catch { /* 取不到就留空 */ }
	const active = devices.find((d) => d && d.active) || null;
	const software = String(feature.gpu_compositing || "") !== "enabled";
	const fps = typeof rafFps === "number" ? rafFps : -1;
	const slow = fps >= 0 && fps < 30;
	const barShort = typeof barWidth === "number" && barWidth < 190;

	const result = {
		variant,
		platform: process.platform,
		arch: process.arch,
		os: `${require("node:os").release()}`,
		versions: {
			electron: process.versions.electron,
			chrome: process.versions.chrome,
			node: process.versions.node,
		},
		switchesInEffect: {
			"use-angle": app.commandLine.getSwitchValue("use-angle"),
			"enable-gpu-rasterization": app.commandLine.hasSwitch("enable-gpu-rasterization"),
			"enable-zero-copy": app.commandLine.hasSwitch("enable-zero-copy"),
			"ignore-gpu-blocklist": app.commandLine.hasSwitch("ignore-gpu-blocklist"),
			"disable-gpu": app.commandLine.hasSwitch("disable-gpu"),
		},
		gpuCompositing: feature.gpu_compositing,
		featureStatus: feature,
		gpuDevices: devices.map((d) => ({
			active: d.active, deviceString: d.deviceString, driverVendor: d.driverVendor,
			driverVersion: d.driverVersion, vendorId: d.vendorId, deviceId: d.deviceId,
		})),
		activeDevice: active ? active.deviceString : null,
		softwareRendering: software,
		rafFps: fps,
		barWidthPx: typeof barWidth === "number" ? Math.round(barWidth * 10) / 10 : barWidth,
		paints: JSON.parse(paints),
		timeline: marks,
		bootOffsetMs: Math.round(BOOT_OFFSET_MS),
		verdict: software || slow || barShort ? "⚠️ 异常（GPU 未生效/出帧退化）" : "✅ 正常",
	};

	console.log("=== GPU-DIAGNOSE-RESULT ===");
	console.log(JSON.stringify(result));
	console.log(
		`[摘要] variant=${variant} platform=${result.platform} electron=${result.versions.electron} ` +
			`合成=${result.gpuCompositing} 软件渲染=${software ? "是 ⚠️" : "否"} ` +
			`活动GPU=${result.activeDevice ? result.activeDevice.slice(0, 60) : "无 ⚠️"} ` +
			`rAF=${fps}fps 进度条=${result.barWidthPx}px(期望≈196) 判定=${result.verdict}`,
	);
	console.log(
		`[时间线] 进程→模块=${result.bootOffsetMs}ms ready=+${marks.ready}ms 窗口=+${marks.windowCreated}ms ` +
			`加载完=+${marks.didFinishLoad}ms 首帧响应=+${marks.firstJsResponsive}ms`,
	);

	win.destroy();
	app.quit();
});
