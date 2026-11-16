// 升级链路加固契约测试（源码级断言，main.cjs 不可 require，沿用本仓 main-*.test.ts 模式）。
// 背景（2026-11-15 事故）：Windows 应用内自动升级时 WaPiKernel.exe 被旧内核进程锁死，
// NSIS 覆盖失败被静默跳过 → 壳 0.10.3 / 核 0.10.1 静默共存。本文件锁死两层防线的接线：
// A) 升级前 stopAndWait 进程级退出确认；C) 打包落盘 manifest.json + 启动时壳/核一致性
// 自检日志告警（不弹窗，co 拍板 2026-11-16）。
// B)（NSIS 解压前先删旧 kernel exe）已撤（2026-11-16 拍板只留 A）：A 保证进程退出锁
// 释放后覆盖写入必然成功，B 属冗余；文末负向用例锁死不回潮。
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const DESKTOP = join(import.meta.dirname, "..");

// ===== 防线 A：升级前等待 kernel 进程真正退出 =====

test("main.cjs 升级前清理：必须 await stopAndWait（进程级退出确认），不得只调 fire-and-forget 的 stop()", () => {
	const src = readFileSync(join(SRC, "main.cjs"), "utf8");
	const i = src.indexOf("onBeforeQuitAndInstall:");
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, i + 1400);
	expect(body).toContain("await sc.stopAndWait");
	// stop() 只允许作为旧签名/无 stopAndWait 时的兜底分支存在
	expect(body).toContain("sc.stop()");
});

test("kernel-sidecar.cjs：必须暴露 stopAndWait 且默认等待走 exit 事件（替换 waitPortReleased 600ms 假信号）", () => {
	const src = readFileSync(join(SRC, "kernel-sidecar.cjs"), "utf8");
	expect(src).toContain("stopAndWait");
	expect(src).toContain('once("exit"');
	// 超时强杀兜底必须走 forceKill（killTree 是优雅 taskkill，锁释放无保证）
	expect(src).toContain("forceKill");
});

// ===== 防线 B 已撤（2026-11-16 拍板只留 A）：负向用例防回潮 =====

test("防线 B 已撤：electron-builder.yml 不得再挂 nsis.include 自定义脚本，build/installer.nsh 不得存在", () => {
	const yml = readFileSync(join(DESKTOP, "electron-builder.yml"), "utf8");
	expect(yml).not.toContain("installer.nsh");
	expect(yml).not.toContain("customInit");
	expect(existsSync(join(DESKTOP, "build", "installer.nsh"))).toBe(false);
});

// ===== 防线 C：打包落盘校验清单 + 启动壳/核自检 =====

test("build-kernel-sidecar.ts：打包必须写 resources/kernel/manifest.json（校验清单落盘）", () => {
	const src = readFileSync(
		join(DESKTOP, "scripts", "build-kernel-sidecar.ts"),
		"utf8",
	);
	expect(src).toContain("manifest.json");
	expect(src).toContain("buildKernelManifest");
});

test("main.cjs 启动时壳/核一致性自检：packaged 下必须调 checkKernelConsistency，不一致只记 error 日志，不得弹窗打扰", () => {
	const src = readFileSync(join(SRC, "main.cjs"), "utf8");
	expect(src).toContain("checkKernelConsistency");
	// 自检必须限定 packaged（dev 从源码跑无 manifest，不得误报）
	expect(src).toContain("app.isPackaged");
	const i = src.indexOf("checkKernelConsistency");
	const body = src.slice(i, i + 1600);
	// 不一致 = 记 error 日志（诊断可查：desktop.log 搜「壳/核一致性校验失败」），不弹窗
	expect(body).toContain("log.error");
	expect(body).toContain("kernel-manifest.cjs");
	// 自检块内不得出现用户可见弹窗（零弹窗原则）
	expect(body).not.toContain("showMessageBox");
});
