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
