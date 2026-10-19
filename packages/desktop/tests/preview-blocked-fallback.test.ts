import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// main.cjs 顶层有 require("electron") 等副作用，无法直接 import；
// 这里读源码字符串校验「预览 iframe 被站点拒绝嵌入 → 转告主窗口」这条链路，
// 防止后续重构误删 did-fail-load 接线（真实验证见 e2e-electron/preview-window.spec.ts）。
const src = readFileSync(join(import.meta.dir, "..", "src", "main.cjs"), "utf8");

test("主进程监听子帧 did-fail-load，只接管 ERR_BLOCKED_BY_RESPONSE（-27）", () => {
	expect(src).toContain('"did-fail-load"');
	// 只处理子帧（主 frame 失败属导航问题，与「站点禁止被嵌入」无关）
	expect(src).toMatch(/if\s*\(\s*isMainFrame\s*\)\s*return/);
	// -27 = ERR_BLOCKED_BY_RESPONSE：X-Frame-Options / CSP frame-ancestors 拦截
	expect(src).toMatch(/errorCode\s*!==\s*-27/);
	expect(src).toContain("ERR_BLOCKED_BY_RESPONSE");
});

test("拦截事件经 previewwin:event 下行给主窗口，形态为 { type: \"blocked\", url }", () => {
	// 复用既有 previewwin:event 通道（主窗口与独立预览窗口共用 onEvent）
	expect(src).toMatch(/type:\s*"blocked"/);
	expect(src).toMatch(/url:\s*String\(\s*validatedURL/);
});

test("两处接线：主窗口 webContents + 独立预览窗口 webContents", () => {
	expect(src).toContain("const wirePreviewBlocked =");
	// 定义行写作 `const wirePreviewBlocked = (`，两处调用带括号：mainWindow.webContents
	// （分屏/全屏内嵌）与预览窗口 win.webContents（浮动独立窗口）
	const calls = src.match(/wirePreviewBlocked\(/g) ?? [];
	expect(calls.length).toBeGreaterThanOrEqual(2);
});
