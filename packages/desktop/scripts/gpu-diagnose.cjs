// gpu-diagnose.cjs —— 打包版「启动卡顿（启动页空白/进度条停住/很久才出界面）」现场取证 demo。
//
// 为什么需要：四个强制 GPU 开关（enable-gpu-rasterization / enable-zero-copy /
// use-angle=d3d11 / ignore-gpu-blocklist）在 macOS 上会把 GPU 整个关掉（合成退化到软件渲染，
// 出帧 60fps → 6~16fps），已修。Windows 上 d3d11 本该是正确后端，但同样报「慢」，需要现场数据
// 判断是「加速被某个开关打坏/没生效」还是「本来就没走 GPU」，故做这个 A/B demo。
//
// 输出方式（**以文件为准**）：Windows 上 electron.exe 属 GUI 子系统程序，console.log 不会
// 进 cmd 窗口，所以结果一律写到文件，默认：
//   %USERPROFILE%\gpu-diagnose.log   （macOS/Linux 为 ~/gpu-diagnose.log）
// 可用 --out=<路径> 覆盖。同时在窗口里回显摘要 + 日志路径（方便截图）。
//
// 用法：
//   A. 仓库里已装 electron（packages/desktop 下执行）：
//        node_modules\.bin\electron scripts\gpu-diagnose.cjs --variant=none
//        node_modules\.bin\electron scripts\gpu-diagnose.cjs --variant=prod
//   B. 独立包（含 electron 运行时）：双击 运行demo.bat，自动跑两种配置
//
// 它只看不写：不连任何服务、不占端口、不读写本应用的数据目录，几秒后自动关窗。
//
// 判定口径：
//   [GPU] 出现「⚠️ 软件渲染」→ 硬件加速实际没生效（GPU 被关掉/被 blocklist 拦下）。
//   rAF < 30fps 或「进度条走完宽度」< 190px → 合成路径退化、首帧被推迟（复现卡顿）。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const arg = (k, dflt = "") =>
	(process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || dflt;
const variant = arg("variant", "prod");
const OUT =
	arg("out") || path.join(os.homedir(), "gpu-diagnose.log");

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
.logo{width:88px;height:88px;border-radius:22px;background:#4BA26F;margin-bottom:20px}
.name{font-size:18px;font-weight:600;margin-bottom:28px}
.bar{width:200px;height:4px;border-radius:99px;background:#e5e5ea;overflow:hidden}
.fill{height:100%;width:8%;border-radius:99px;background:#4BA26F;transition:width .45s cubic-bezier(.4,0,.2,1)}
.status{margin-top:16px;font-size:12px;color:#86868b;min-height:16px}
pre{margin-top:14px;max-width:92vw;max-height:40vh;overflow:auto;font-size:11px;line-height:1.5;
white-space:pre-wrap;color:#3a3a3c;background:#fff;border-radius:10px;padding:10px 12px;text-align:left}
</style></head><body>
<div class="logo"></div><div class="name">WA PI Agent（GPU 诊断 demo）</div>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="status" id="status">正在启动…</div>
<pre id="report" style="display:none"></pre>
<script>window.__setProgress=function(p,t){var f=document.getElementById('fill');if(f)f.style.width=Math.max(5,Math.min(100,p))+'%';var s=document.getElementById('status');if(s&&t)s.textContent=t;};
window.__showReport=function(t){var r=document.getElementById('report');if(r){r.style.display='block';r.textContent=t;}};</script>
</body></html>`;

app.whenReady().then(async () => {
	const marks = { ready: Date.now() - T0 };
	const win = new BrowserWindow({
		width: 520, height: 460, resizable: true, show: true,
		title: `GPU 诊断 ${variant}`,
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
		os: os.release(),
		versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
		switchesInEffect: {
			"use-angle": app.commandLine.getSwitchValue("use-angle"),
			"use-gl": app.commandLine.getSwitchValue("use-gl"),
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

	const summaryLine =
		`[摘要] variant=${variant} platform=${result.platform}(${result.os}) electron=${result.versions.electron} ` +
		`合成=${result.gpuCompositing} 软件渲染=${software ? "是 ⚠️" : "否"} ` +
		`活动GPU=${result.activeDevice ? result.activeDevice.slice(0, 70) : "无 ⚠️"} ` +
		`rAF=${fps}fps 进度条=${result.barWidthPx}px(期望≈196) 判定=${result.verdict}`;
	const timelineLine =
		`[时间线] 进程→模块=${result.bootOffsetMs}ms ready=+${marks.ready}ms 窗口=+${marks.windowCreated}ms ` +
		`加载完=+${marks.didFinishLoad}ms 首帧响应=+${marks.firstJsResponsive}ms`;

	// 落盘（覆盖写：每个 variant 一行，避免两次运行互相覆盖时看不出是哪个）
	const header = `${summaryLine}\n${timelineLine}\n`;
	try {
		fs.appendFileSync(OUT, `${header}\n=== GPU-DIAGNOSE-RESULT variant=${variant} ===\n${JSON.stringify(result)}\n\n`);
	} catch (e) {
		// 文件写不进去也要让用户看到（窗口里已回显）
	}
	// 控制台也打一份（macOS/Linux 直接可见；Windows GUI 下看不到，以文件为准）
	console.log(`${header}日志文件: ${OUT}`);

	// 窗口里回显：便于截图，不必找文件
	try {
		await js(
			`window.__setProgress(100,'完成');window.__showReport(${JSON.stringify(
				`${header}\n日志文件: ${OUT}`,
			)})`,
		);
	} catch { /* 回显失败不影响结果 */ }
	// 留 6 秒给用户截图，然后自动退出（.bat 会接着跑第二种配置）
	await new Promise((r) => setTimeout(r, 6000));
	win.destroy();
	app.quit();
});
