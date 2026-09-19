import { defineConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Electron E2E 配置：验证「浮动模式 = 独立系统窗口」这条只有真实 Electron 才有的链路
// （浏览器 E2E 无 Electron IPC 桥，只能验到宿主渲染层）。
//
// 数据目录与端口都与真实运行环境隔离，避免污染用户数据或撞上已在跑的实例：
// - WA_PI_DIR：独立目录（默认 ~/.wa-pi-e2e-electron），spec 开头清空重建
// - 端口：默认 19776（真实 kernel 9778 / 浏览器 E2E 9776 都不冲突）
// - user-data-dir：隔离 Electron 单例锁（否则用户正在用桌面端时本 E2E 会直接退出）
export const ELECTRON_E2E_DIR =
	process.env.WA_PI_E2E_ELECTRON_DIR ||
	join(process.env.HOME || ".", ".wa-pi-e2e-electron");
export const ELECTRON_E2E_PORT =
	Number(process.env.WA_PI_E2E_ELECTRON_PORT) || 19776;

mkdirSync(ELECTRON_E2E_DIR, { recursive: true });

export default defineConfig({
	testDir: "./e2e-electron",
	// 共享同一个 Electron 实例与隔离 kernel：必须串行（并行会互相改窗口/预览状态）
	workers: 1,
	// Electron 首启要拉 kernel sidecar + 加载前端，超时给足
	timeout: 180_000,
	expect: { timeout: 20_000 },
	// 无 webServer：Electron 自己拉起 kernel sidecar 与静态前端
});
