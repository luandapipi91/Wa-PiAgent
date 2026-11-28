// 主窗口状态持久化的 main.cjs 接线断言（main.cjs 依赖 electron 无法直接实例化，
// 按仓库既有范式做源码断言，同 main-pet-show-main.test.ts）：
// 1) createWindow 必须恢复持久化状态（位置/大小/最大化）
// 2) 主窗口 close 必须保存状态（覆盖「隐藏到托盘」与「真实退出/更新重启」两条路径）
// 3) 存取器必须装配在 userData/window_state.json
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const mainSrc = () => readFileSync(join(SRC, "main.cjs"), "utf8");

test("main.cjs：createWindow 恢复持久化的窗口状态（更新重启/重开不再回默认）", () => {
	const src = mainSrc();
	const i = src.indexOf("function createWindow()");
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, i + 2600);
	// 建窗前先读回上次状态
	expect(body).toContain("restoreWindowState()");
	// 有状态用恢复的尺寸/坐标，无状态才回默认值
	expect(body).toContain("restoredWindowState");
	expect(body).toContain("restoredWindowState.width : 1280");
	// 上次是最大化 → 只记为「待恢复」，由 revealMainWindow 在显窗时 maximize。
	// 绝不能对 show:false 的隐藏窗口 maximize：Electron 的 maximize() 会把未显示的窗口
	// 直接显示出来（2026-11-28 用户报告：Windows 首启启动页还没走完，空白主窗口就先冒出来）
	expect(body).toContain("pendingMaximizedRestore");
	expect(body).not.toContain("mainWindow.maximize()");
});

test("main.cjs：最大化恢复推迟到 revealMainWindow，且 maximize 与 show 二选一（无尺寸跳变）", () => {
	const src = mainSrc();
	const i = src.indexOf("function revealMainWindow()");
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, src.indexOf("\n}", i));
	expect(body).toMatch(
		/if \(pendingMaximizedRestore\) \{[\s\S]*mainWindow\.maximize\(\);[\s\S]*\} else \{[\s\S]*mainWindow\.show\(\);/,
	);
});

test("main.cjs：启动中途退出时，尚未应用的最大化恢复也要落盘（不丢用户偏好）", () => {
	const src = mainSrc();
	const i = src.indexOf("function saveWindowState()");
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, src.indexOf("\n}", i));
	expect(body).toContain("pendingMaximizedRestore || mainWindow.isMaximized()");
});

test("main.cjs：主窗口 close 时保存状态（覆盖隐藏到托盘与真实退出/更新重启）", () => {
	const src = mainSrc();
	const fnStart = src.indexOf("function createWindow()");
	expect(fnStart).toBeGreaterThan(0);
	// 主窗口的 close 处理器在 createWindow 体内，先定位再断言，避免命中其它窗口
	const i = src.indexOf('mainWindow.on("close"', fnStart);
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, i + 300);
	expect(body).toContain("saveWindowState()");
});

test("main.cjs：窗口状态存取器装配在 userData/window_state.json", () => {
	const src = mainSrc();
	expect(src).toContain("createWindowStateStore");
	expect(src).toContain('"window_state.json"');
});
