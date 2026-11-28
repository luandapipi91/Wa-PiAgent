// Electron 真实运行时回归：独立 fixture 进程驱动真实 BrowserWindow，
// 验证「保存 → （模拟进程重启）→ 新进程恢复 bounds」闭环。
// fixture 不加载 kernel / 不绑定业务端口 / 状态文件在临时目录，不影响本机正在运行的实例。
// （main.cjs 的完整 app 启动会与本机在跑的 wa-pi 共享端口/登记簿，不适合在本机直接拉起）
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESKTOP = join(import.meta.dirname, "..");
const MODULE = join(DESKTOP, "src", "window-state.cjs");

function electronBin(): string {
	// electron 包的 main 导出就是可执行文件路径（跨平台；Windows 下 .bin 只有 electron.cmd shim，
	// 原 candidates 在 Windows 上找不到）
	const fromPkg = require("electron");
	if (typeof fromPkg === "string" && existsSync(fromPkg)) return fromPkg;
	const candidates = [
		join(DESKTOP, "node_modules", ".bin", "electron"),
		join(DESKTOP, "..", "..", "node_modules", ".bin", "electron"),
	];
	for (const c of candidates) if (existsSync(c)) return c;
	throw new Error("electron 可执行文件未找到");
}

/** 生成并运行一次 fixture（phase: save | restore），返回写出的结果 JSON */
function runFixture(phase: string, stateFile: string): Record<string, unknown> {
	const fixture = join(
		mkdtempSync(join(tmpdir(), "win-state-fx-")),
		"fixture.cjs",
	);
	writeFileSync(
		fixture,
		`const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const { createWindowStateStore, sanitizeWindowState } = require(${JSON.stringify(MODULE)});
const phase = process.argv[2];
const stateFile = process.argv[3];
const resultFile = process.argv[4];
app.whenReady().then(() => {
	try {
		const store = createWindowStateStore(stateFile);
		let result;
		if (phase === "save") {
			const win = new BrowserWindow({ x: 137, y: 177, width: 800, height: 600, show: false });
			const bounds = win.getBounds();
			const state = { ...bounds, maximized: win.isMaximized() };
			store.write(state);
			result = { ok: true, saved: state };
		} else if (phase === "maximize-hidden") {
			// 机制实证：show:false 的隐藏窗口一执行 maximize() 就会被显示出来（Electron 文档：
			// 「若窗口尚未显示，这也会显示它」）。main.cjs 据此把最大化恢复推迟到显窗时。
			const win = new BrowserWindow({ x: 137, y: 177, width: 800, height: 600, show: false });
			const visibleBefore = win.isVisible();
			win.maximize();
			result = { ok: true, visibleBefore, visibleAfter: win.isVisible(), maximizedAfter: win.isMaximized() };
			// 不 destroy：Electron 43 / Windows 下「刚显示的窗口 destroy 后立即 app.exit」会在退出阶段
			// 崩成 0xC0000409（结果已正确写出，只是进程状态非 0）；与 save / restore 阶段一致，窗口随 app.exit 回收
		} else {
			const restored = sanitizeWindowState(store.read(), screen.getAllDisplays());
			if (!restored) {
				result = { ok: false, error: "restore 返回 null" };
			} else {
				const win = new BrowserWindow({ x: restored.x, y: restored.y, width: restored.width, height: restored.height, show: false });
				result = { ok: true, restored, actual: win.getBounds() };
			}
		}
		fs.writeFileSync(resultFile, JSON.stringify(result));
		app.exit(0);
	} catch (e) {
		try { fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: String(e) })); } catch {}
		app.exit(1);
	}
});
`,
	);
	const resultFile = join(tmpdir(), `win-state-result-${phase}-${Date.now()}.json`);
	try {
		const r = spawnSync(electronBin(), [fixture, phase, stateFile, resultFile], {
			timeout: 60_000,
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		return JSON.parse(readFileSync(resultFile, "utf8"));
	} finally {
		rmSync(fixture, { force: true });
		rmSync(resultFile, { force: true });
	}
}

test(
	"electron 真实运行时：save 阶段真实 BrowserWindow bounds 落盘",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "win-state-e2e-"));
		try {
			const stateFile = join(dir, "window_state.json");
			const result = runFixture("save", stateFile);
			expect(result.ok).toBe(true);
			// 落盘内容 = 真实窗口的 getBounds + isMaximized
			expect(result.saved).toEqual({
				x: 137,
				y: 177,
				width: 800,
				height: 600,
				maximized: false,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	90_000,
);

test(
	"electron 真实运行时：隐藏窗口执行 maximize() 会被立即显示（最大化恢复必须推迟到显窗时）",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "win-state-e2e-"));
		try {
			const result = runFixture("maximize-hidden", join(dir, "window_state.json"));
			expect(result.ok).toBe(true);
			expect(result.visibleBefore).toBe(false);
			// 这正是启动页阶段空白主窗口提前冒出来的机制：createWindow 里对 show:false 窗口 maximize
			expect(result.visibleAfter).toBe(true);
			expect(result.maximizedAfter).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	90_000,
);

test(
	"electron 真实运行时：新进程按持久化状态建窗，bounds 完整恢复（更新重启闭环）",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "win-state-e2e-"));
		try {
			const stateFile = join(dir, "window_state.json");
			const saved = runFixture("save", stateFile);
			expect(saved.ok).toBe(true);
			// 模拟「进程重启」：另起一个全新 electron 进程读同一份状态文件建窗
			const result = runFixture("restore", stateFile);
			expect(result.ok).toBe(true);
			expect(result.restored).toEqual(saved.saved);
			// 新窗口的 getBounds() 与上次保存的一致
			expect(result.actual).toEqual({
				x: 137,
				y: 177,
				width: 800,
				height: 600,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	120_000,
);
