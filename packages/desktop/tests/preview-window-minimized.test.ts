// main.cjs 浮动预览窗「最小化态重建」契约（源码字符串断言）。
//
// 背景 bug（2026-10-10）：预览窗口最小化后切换会话再切回，窗口被自动恢复打开。
// 根因：①切走会话窗口被 close 销毁，切回时重建，首帧 act ready 无条件 show，
// 重建路径不感知 minimized；②driver 发出的 previewwin:cmd hide 在主进程没有
// 对应 case 被静默丢弃。
//
// main.cjs 顶层有 require("electron") 等副作用，无法直接 import（同
// preview-blocked-fallback.test.ts 的做法），读源码字符串锁定关键接线；
// 前端行为契约见 frontend/tests/preview-window-driver.test.tsx。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "main.cjs"), "utf8");

test("previewwin:cmd 处理器实现 hide 分支（状态驱动的隐藏通道闭环）", () => {
	// 提取 previewwin:cmd 的 switch 块，确认 hide 不再落 default 被丢弃
	const i = src.indexOf('"previewwin:cmd"');
	expect(i).toBeGreaterThan(-1);
	const block = src.slice(i, i + 1200);
	expect(block).toContain('case "hide"');
});

test("createPreviewWindow 接收 payload.minimized（重建路径感知最小化）", () => {
	// open 的 invoke payload 透传 minimized：主进程据此设置首帧 ready 的显示决策
	expect(src).toMatch(/payload\.minimized/);
});

test("act ready 的 show 受 pending 门控（最小化态重建保持隐藏，不自动弹窗）", () => {
	// ready 不再无条件 show：仅当本次开窗未以最小化态启动时才显示
	expect(src).toMatch(/previewReadyShowPending/);
	const i = src.indexOf('case "ready"');
	expect(i).toBeGreaterThan(-1);
	const block = src.slice(i, i + 400);
	expect(block).toContain("previewReadyShowPending");
});
