import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// main.cjs 顶层有 require("electron") 等副作用，无法直接 import；
// 这里读源码字符串校验 webPreferences 配置，防止后续误删 sandbox:false 导致打包后复制失效。
// （Electron 20+ 默认开启 sandbox，preload 无法 require electron.clipboard → 复制功能失效）
const src = readFileSync(
	join(import.meta.dir, "..", "src", "main.cjs"),
	"utf8",
);

test("主进程 LOCALE 在 app ready 后求值（getPlugins ready 前返回空串 → 曾致中文打包版首启 splash 恒为英文）", () => {
	// 顶层不得再直接用 app.getLocale() 求值（ready 前返回空串，Electron 43 实测）
	expect(src).not.toContain("const SYSTEM_LOCALE = app.getLocale();");
	// 不存在 --lang 开关（曾用空串值污染渲染进程 locale，已回滚）
	expect(src).not.toContain('appendSwitch("lang"');
	// whenReady 回调开头重算 LOCALE（任何 splash/t() 使用之前）
	expect(src).toContain(
		'LOCALE = app.getLocale().startsWith("zh") ? "zh" : "en";',
	);
	const reassignIdx = src.indexOf('LOCALE = app.getLocale().startsWith("zh")');
	const readyIdx = src.indexOf("app.whenReady()");
	// 字符顺序：whenReady 语句先出现，重算在它的回调体内（执行时 ready 后才跑）
	expect(reassignIdx).toBeGreaterThan(readyIdx);
	// createSplash 的调用点必须在重算之后（whenReady 回调内，splash 首帧前已完成重算）
	const splashCallIdx = src.indexOf("createSplash();");
	expect(splashCallIdx).toBeGreaterThan(reassignIdx); // splash 创建前已完成重算
});

test("splashWindow 与 mainWindow 均显式关闭 sandbox，保证 preload 能 require clipboard", () => {
	// 只匹配 BrowserWindow 的 webPreferences（WebContentsView 内容视图刻意不挂 preload/sandbox 保持隔离）
	const blocks =
		src.match(/new BrowserWindow\([\s\S]*?webPreferences:\s*\{[^}]*\}/g) ?? [];
	expect(blocks.length).toBeGreaterThanOrEqual(2);

	for (const b of blocks) {
		expect(b).toContain("contextIsolation: true");
		expect(b).toContain("nodeIntegration: false");
		// 关键：sandbox 必须为 false，否则 Electron 43 默认 sandbox 会让 preload 的 require('electron') 只拿到白名单子集
		expect(b).toContain("sandbox: false");
		expect(b).toContain("preload:");
	}
});

test("外链子窗口：内容视图 WebContentsView 保持隔离，不挂 preload、不开 nodeIntegration", () => {
	const viewBlock =
		src.match(/new WebContentsView\([\s\S]*?webPreferences:\s*\{[^}]*\}/g) ?? [];
	expect(viewBlock.length).toBeGreaterThanOrEqual(1);
	const b = viewBlock[0];
	expect(b).toContain("nodeIntegration: false");
	expect(b).toContain("contextIsolation: true");
	expect(b).toContain("sandbox: true");
	expect(b).not.toContain("preload:");
});

test("外链子窗口使用本地地址栏壳 + WebContentsView 承载内容", () => {
	expect(src).toContain(
		'child.loadFile(path.join(__dirname, "assets", "link-window.html"))',
	);
	expect(src).toContain("child.contentView.addChildView(view)");
	expect(src).toContain("linkwin:load");
	expect(src).toContain("linkwin:ready");
	expect(src).toContain("linkwin:url-changed");
	expect(src).toContain("normalizeUrl");
});

test("外链子窗口不设置 parent: mainWindow（macOS 多屏拖动消失防回归）", () => {
	// Electron #31815：macOS 上带 parent 的 child window 拖到不同缩放的扩展显示器会消失。
	// 移除 parent 后需确保不回归。
	expect(src).not.toContain("parent: mainWindow");
});

test("主窗口收起时同步隐藏所有外链子窗口（补偿移除 parent 后的 owned-window 跟随行为）", () => {
	// 移除 parent 后，主窗口 hide 不再自动隐藏子窗口，需手动同步隐藏。
	expect(src).toContain("childWindows");
	expect(src).toContain("if (!w.isDestroyed()) w.hide();");
});

test("地址栏壳页面包含地址输入/复制/导航交互", () => {
	const html = readFileSync(
		join(import.meta.dir, "..", "src", "assets", "link-window.html"),
		"utf8",
	);
	expect(html).toContain('id="url"');
	expect(html).toContain('id="copy"');
	expect(html).toContain('id="go"');
	expect(html).toContain("waPiLinkWin");
	expect(html).toContain("onUrlChanged");
	expect(html).toContain("waPiClipboard");
});

test("预览独立窗口：浮动模式的承载窗口（无边框自绘 + 单例 + 主进程中转 IPC）", () => {
	const blocks =
		src.match(/new BrowserWindow\(\{[\s\S]*?webPreferences:\s*\{[^}]*\}/g) ?? [];
	// 预览窗口是文件里最后一个 BrowserWindow（splash → 主窗口 → 外链子窗口 → 预览窗口）
	const previewBlock = blocks.filter((b) => b.includes("frame: false")).at(-1);
	expect(previewBlock).toBeTruthy();
	// 无边框自绘：拖动区由前端工具栏承担（-webkit-app-region: drag）
	expect(previewBlock!).toContain("frame: false");
	// 等前端首帧渲染完成（act: ready）后再显示，避免白屏
	expect(previewBlock!).toContain("show: false");
	expect(previewBlock!).toContain("minWidth: PREVIEW_MIN_W");
	// 同外链子窗口：不设 parent（macOS 多屏拖动消失防回归）
	expect(previewBlock!).not.toContain("parent:");

	// URL 标记：与前端 preview-window.ts 的 PREVIEW_WIN_PARAM 对应（前端据此分流渲染预览窗口根）
	expect(src).toContain('"wa-preview-win"');
	// 四类 IPC：开窗 / 窗口指令 / 动作上报 / 缩放手柄，事件统一走 previewwin:event 中转
	expect(src).toContain('ipcMain.handle("previewwin:open"');
	expect(src).toContain('ipcMain.on("previewwin:cmd"');
	expect(src).toContain('ipcMain.on("previewwin:act"');
	expect(src).toContain('ipcMain.on("previewwin:set-size"');
	expect(src).toContain('"previewwin:event"');
});

test("预览独立窗口：只接受主窗口的开窗请求（防独立窗口自身递归开窗）", () => {
	expect(src).toContain('return { ok: false, reason: "forbidden" };');
	expect(src).toContain("event.sender !== mainWindow.webContents");
});

test("预览独立窗口：已存在时同步最新预览内容（主窗口切会话/切文件后不显示陈旧内容）", () => {
	expect(src).toContain('type: "sync"');
});

test("主窗口收起时同步隐藏预览独立窗口", () => {
	expect(src).toContain(
		"if (previewWindow && !previewWindow.isDestroyed()) previewWindow.hide();",
	);
});

test("preload 暴露 waPiPreviewWin 桥（开窗/指令/动作/缩放/事件）", () => {
	const preload = readFileSync(
		join(import.meta.dir, "..", "src", "preload.cjs"),
		"utf8",
	);
	expect(preload).toContain('exposeInMainWorld("waPiPreviewWin"');
	for (const member of ["open:", "cmd:", "act:", "setSize:", "onEvent:"]) {
		expect(preload).toContain(member);
	}
});
