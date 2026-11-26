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

test("filepreviewwin:cmd 实现 close/restore（无死通道）", () => {
	const i = mainSrc.indexOf('"filepreviewwin:cmd"');
	expect(i).toBeGreaterThan(-1);
	const block = mainSrc.slice(i, i + 800);
	expect(block).toContain('case "close"');
	// restore：双击与当前预览同一文件时 store 同值短路不会触发 driver open，
	// 窗口若被隐藏（如主窗口收起到托盘时连带 hide）唯一唤回通道就是这条指令
	expect(block).toContain('case "restore"');
	// 反向断言：hide/refresh 仍是 html 窗口专属语义（气泡态/iframe 刷新），文件窗口不许出现
	expect(block).not.toContain('"hide"');
	expect(block).not.toContain('"refresh"');
});

// 主窗口收起到托盘时预览窗被连带 hide，而从托盘恢复只 show 主窗口；若单例分支不唤回，
// 双击任何文件都只 sync 换内容、窗口永不显示，表现为静默失效直到重启（2026-11-26 修）。
test("filepreviewwin:open 单例分支：文件窗口不可见时唤回（restore+show），html 保持不打扰", () => {
	const i = mainSrc.indexOf("if (existing.isVisible()) existing.focus()");
	expect(i).toBeGreaterThan(-1);
	const block = mainSrc.slice(i - 500, i);
	// 仅文件窗口唤回（isFile 守卫）；html 窗口的最小化气泡态仍靠点气泡 restore，不得被打破
	expect(block).toContain("isFile");
	expect(block).toContain("!existing.isVisible()");
	expect(block).toContain("existing.restore()");
	expect(block).toContain("existing.show()");
});

// ready 是窗口显示唯一入口：loadURL "成功"但前端 JS 未跑到 ready（崩溃/白屏）时
// did-fail-load 不触发，若不兕底则单例变量已赋值，之后每次双击都命中单例分支，
// 重启前永久失效（2026-11-26 补充防御）。
test("file 窗口 ready 超时兕底：超时未 ready → load-failed 回报 + 关窗（下次双击重开即恢复）", () => {
	expect(mainSrc).toContain("FILE_PREVIEW_READY_TIMEOUT_MS");
	expect(mainSrc).toContain("filePreviewReadyTimer");
	const t = mainSrc.indexOf("FILE_PREVIEW_READY_TIMEOUT_MS)");
	expect(t).toBeGreaterThan(-1);
	const block = mainSrc.slice(t, t + 700);
	expect(block).toContain("load-failed");
	expect(block).toContain("win.close()");
	// ready 消费后解除兕底（正常路径不误伤）
	const r = mainSrc.indexOf('case "ready"');
	expect(mainSrc.slice(r, r + 500)).toContain("filePreviewReadyTimer");
	// closed 兜底清 timer 防泄漏
	const c = mainSrc.indexOf('win.on("closed"');
	expect(mainSrc.slice(c, c + 700)).toContain("filePreviewReadyTimer");
});

test("file 窗口 did-fail-load 兕底：仅主 frame 真失败触发（过滤 ERR_ABORTED），load-failed + 关窗", () => {
	const i = mainSrc.indexOf('win.webContents.on("did-fail-load"');
	expect(i).toBeGreaterThan(-1);
	const block = mainSrc.slice(i, i + 500);
	expect(block).toContain("isMainFrame");
	expect(block).toContain("-3"); // ERR_ABORTED 非真失败
	expect(block).toContain("load-failed");
	expect(block).toContain("win.close()");
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
