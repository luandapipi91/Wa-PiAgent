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
	const reassignIdx = src.indexOf(
		'LOCALE = app.getLocale().startsWith("zh")',
	);
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
