// gpu-status.cjs 单元测试。
//
// 背景：现有启动日志里那行「GPU 信息:」永远是空的——根因是 log.info 只接受一个参数
// （log.cjs 的 info: (m) => write(...)），第二个参数被静默丢弃。于是「打包版到底有没有
// 走硬件加速」这个最关键的事实，两个平台上都无从查证。
// 这里换成单一字符串摘要：把 gpu_compositing / rasterization / 2d_canvas / webgl 与
// gpuDevice.active 压成一行，软件渲染时带 ⚠️ 前缀（一眼能看出退化）。
import { test, expect } from "bun:test";
import { summarizeGpuStatus, isSoftwareFallback } from "../src/util/gpu-status.cjs";

// 真实取样：macOS 无开关（Electron 默认，健康）
const HEALTHY = {
	gpu_compositing: "enabled",
	rasterization: "enabled",
	"2d_canvas": "enabled",
	webgl: "enabled",
};
const HEALTHY_DEVICE = [
	{ active: true, deviceString: "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon RX 460, Version 15.7.9 (Build 24G830))" },
];

// 真实取样：macOS 加上四个强制开关（GPU 被彻底关掉 → 软件渲染 → 出帧掉到个位数）
const SOFTWARE = {
	gpu_compositing: "disabled_software",
	rasterization: "disabled_software",
	"2d_canvas": "disabled_software",
	webgl: "disabled_off",
	opengl: "disabled_off",
};
const SOFTWARE_DEVICE = [{ active: false, deviceId: 0, vendorId: 0 }];

test("健康状态：合成/光栅/2D/WebGL 全 enabled，设备串带上，无 ⚠️", () => {
	const s = summarizeGpuStatus(HEALTHY, HEALTHY_DEVICE);
	expect(s).toContain("合成=enabled");
	expect(s).toContain("光栅=enabled");
	expect(s).toContain("2D=enabled");
	expect(s).toContain("WebGL=enabled");
	expect(s).toContain("AMD Radeon RX 460");
	expect(s).not.toContain("⚠️");
	expect(isSoftwareFallback(HEALTHY)).toBe(false);
});

test("软件渲染：明确标 ⚠️ + 「软件渲染」，设备显示未激活（本次卡顿的现场特征）", () => {
	const s = summarizeGpuStatus(SOFTWARE, SOFTWARE_DEVICE);
	expect(s).toContain("⚠️");
	expect(s).toContain("软件渲染");
	expect(s).toContain("合成=disabled_software");
	expect(s).toContain("GPU=未激活");
	expect(isSoftwareFallback(SOFTWARE)).toBe(true);
});

test("字段缺失/异常输入不炸（拿不到状态时给出 unknown 而非抛错）", () => {
	expect(() => summarizeGpuStatus(undefined, undefined)).not.toThrow();
	expect(summarizeGpuStatus(undefined, undefined)).toContain("合成=");
	expect(summarizeGpuStatus({}, [])).toContain("GPU=未知");
	// 非 enabled 的非软件态（如 disabled_off）同样算退化，必须可见
	expect(isSoftwareFallback({ gpu_compositing: "disabled_off" })).toBe(true);
	expect(summarizeGpuStatus({ gpu_compositing: "disabled_off" }, [])).toContain("⚠️");
});
