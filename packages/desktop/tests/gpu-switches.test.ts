// gpu-switches.cjs 单元测试。
//
// 背景 bug（2026-09-18）：打包版启动时启动页长时间空白、进度条停在低位不推进，
// 主窗口也迟迟不绘制内容。最小复现实验（真实 Electron 43 + 真实启动页 HTML）：
// 同一台 macOS 机器、同一页面，仅改命令行开关，rAF 出帧率 60fps → 6~16fps，
// 单变量隔离定位到 `use-angle=d3d11`（Windows 专属 ANGLE 后端，macOS 上强制指定
// 会把合成路径打到降级状态），其余三个开关单独开均为 57~62fps。
// 因此四个开关必须按平台门控：只有 Windows 才加。
import { test, expect } from "bun:test";
import { gpuSwitchesFor } from "../src/util/gpu-switches.cjs";

test("win32：四个开关全量（Windows 双显卡本靠它们启用硬件加速）", () => {
	expect(gpuSwitchesFor("win32")).toEqual([
		["enable-gpu-rasterization"],
		["enable-zero-copy"],
		["use-angle", "d3d11"],
		["ignore-gpu-blocklist"],
	]);
});

test("darwin：不加任何开关（use-angle=d3d11 是 Windows 专属，会让出帧掉到个位数）", () => {
	const switches = gpuSwitchesFor("darwin");
	expect(switches).toEqual([]);
	// 回归护栏：macOS 上绝不允许出现 d3d11（本次卡顿的直接原因）
	expect(switches.some(([k, v]) => k === "use-angle" && v === "d3d11")).toBe(false);
});

test("linux：不加任何开关（d3d11 同样不存在，Chromium 默认已开硬件加速）", () => {
	expect(gpuSwitchesFor("linux")).toEqual([]);
});

test("缺省/未知平台：按非 Windows 处理，不加开关（宁可默认，不要赌出帧）", () => {
	expect(gpuSwitchesFor(undefined)).toEqual([]);
	expect(gpuSwitchesFor("freebsd")).toEqual([]);
});
