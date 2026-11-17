// main.cjs / preload.cjs 文件预览独立窗口契约（源码字符串断言）。
//
// main.cjs 顶层有 require("electron") 等副作用，无法直接 import（同
// preview-window-minimized.test.ts / preview-blocked-fallback.test.ts 的做法），
// 读源码字符串锁定关键接线；前端行为契约见 frontend 侧 driver / 组件测试。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mainSrc = readFileSync(join(import.meta.dir, "..", "src", "main.cjs"), "utf8");
const preloadSrc = readFileSync(join(import.meta.dir, "..", "src", "preload.cjs"), "utf8");

// ── 任务 2：preload 桥 ──

// preload 用参数化工厂暴露两座同构桥（规格钉死：不复制五方法代码），
// 故断言「工厂接线」而非 exposeInMainWorld 字面量；通道名 literal 由 main.cjs 侧断言锁。
test("preload 暴露 waPiFilePreviewWin 桥（工厂接线 filepreviewwin 前缀）", () => {
	expect(preloadSrc).toContain('exposePreviewBridge("waPiFilePreviewWin", "filepreviewwin")');
	// 工厂体把五方法接到同前缀五通道（模板字面量）
	for (const ch of ["${prefix}:open", "${prefix}:cmd", "${prefix}:act", "${prefix}:set-size", "${prefix}:event"]) {
		expect(preloadSrc).toContain(ch);
	}
});

test("既有 html 桥（waPiPreviewWin / previewwin 前缀）不回归", () => {
	expect(preloadSrc).toContain('exposePreviewBridge("waPiPreviewWin", "previewwin")');
});

// ── 任务 3：main.cjs 文件预览独立窗口链路 ──

test("filePreviewWindow 与 filePreviewReadyShowPending 单例状态存在", () => {
	expect(mainSrc).toContain("let filePreviewWindow");
	expect(mainSrc).toContain("filePreviewReadyShowPending");
});

test("filepreviewwin:open 只认主窗口 sender（防独立窗口递归开窗）", () => {
	const i = mainSrc.indexOf('"filepreviewwin:open"');
	expect(i).toBeGreaterThan(-1);
	expect(mainSrc.slice(i, i + 300)).toContain("event.sender !== mainWindow.webContents");
});

test("filepreviewwin:cmd 仅实现 close（无死通道）", () => {
	const i = mainSrc.indexOf('"filepreviewwin:cmd"');
	expect(i).toBeGreaterThan(-1);
	const block = mainSrc.slice(i, i + 800);
	expect(block).toContain('case "close"');
	// 反向断言：restore/hide/refresh 都是 html 窗口专属语义，文件窗口不许出现
	expect(block).not.toContain('"restore"');
	expect(block).not.toContain('"hide"');
	expect(block).not.toContain('"refresh"');
});

test("filepreviewwin:act 只认文件窗口 sender", () => {
	const i = mainSrc.indexOf('"filepreviewwin:act"');
	expect(i).toBeGreaterThan(-1);
	const block = mainSrc.slice(i, i + 400);
	expect(block).toContain("filePreviewWindow");
	expect(block).toContain("event.sender !== filePreviewWindow.webContents");
});

test("filepreviewwin:set-size 只认文件窗口 sender 并夹最小尺寸", () => {
	const i = mainSrc.indexOf('"filepreviewwin:set-size"');
	expect(i).toBeGreaterThan(-1);
	const block = mainSrc.slice(i, i + 500);
	expect(block).toContain("event.sender !== filePreviewWindow.webContents");
	expect(block).toContain("PREVIEW_MIN_W");
});

test("loadURL 携带 kind=file 且 html 路径不设 kind", () => {
	expect(mainSrc).toContain('params.set("kind", "file")');
	// html 窗口的 params 构造处不得无条件设 kind（向后兼容旧窗口 URL）
	const i = mainSrc.indexOf('"wa-preview-win": "1"');
	expect(i).toBeGreaterThan(-1);
	const head = mainSrc.slice(i, i + 200);
	expect(head).not.toContain('params.set("kind"');
});

test("文件窗口 closed 兜底清自身单例并回报", () => {
	// createPreviewWindow 内的 closed 监听（第二个，属于文件窗口链路）
	expect(mainSrc).toContain("filePreviewWindow = null");
	// sendToMain 支持 filepreviewwin:event 通道（下行事件参数化）
	expect(mainSrc).toContain('"filepreviewwin:event"');
});

test("html 专属接线（blocked/modkey）不进文件窗口", () => {
	// createPreviewWindow 内：两处接线必须被 kind 条件保护
	const i = mainSrc.indexOf("wirePreviewBlocked(win.webContents)");
	expect(i).toBeGreaterThan(-1);
	const ctx = mainSrc.slice(Math.max(0, i - 200), i + 200);
	expect(ctx).toMatch(/isFile/);
	const j = mainSrc.indexOf("wireModKeyRelay(win.webContents)");
	expect(j).toBeGreaterThan(-1);
	const ctx2 = mainSrc.slice(Math.max(0, j - 200), j + 200);
	expect(ctx2).toMatch(/isFile/);
});

test("文件窗口 act 语义：ready/close/path/open-settings 且 path 带 sessionId", () => {
	// handlePreviewAct 的 file 分支：path 转发必须带 sessionId（主窗口 openFilePreview 需要）
	expect(mainSrc).toContain("sessionId: payload.sessionId ?? null");
	const i = mainSrc.indexOf('ipcMain.on("filepreviewwin:act"');
	expect(i).toBeGreaterThan(-1);
	// act 分发进 file 语义（kind 参数）
	const block = mainSrc.slice(i, i + 300);
	expect(block).toContain('"file"');
});
