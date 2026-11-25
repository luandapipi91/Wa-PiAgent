// 主窗口状态持久化：位置/大小/最大化状态的文件读写与屏内校验的单元测试。
// 背景：更新重启（quitAndInstall → 安装器拉起新壳）与彻底退出是进程真实退出的少数场景，
// 主窗口原本没有持久化，重启后必回硬编码默认值。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWindowStateStore,
	sanitizeWindowState,
} from "../src/window-state.cjs";

/** 单屏 1920x1080（Electron screen.getAllDisplays() 的形状） */
const DISPLAY = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];

// ── 文件读写 ────────────────────────────────────────────────

test("createWindowStateStore：文件不存在 → read 返回 null，不抛异常", () => {
	const dir = mkdtempSync(join(tmpdir(), "win-state-"));
	try {
		const store = createWindowStateStore(join(dir, "window_state.json"));
		expect(store.read()).toBeNull();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createWindowStateStore：文件损坏（非法 JSON）→ read 返回 null，不抛异常", () => {
	const dir = mkdtempSync(join(tmpdir(), "win-state-"));
	try {
		const file = join(dir, "window_state.json");
		writeFileSync(file, "{ not valid json !!");
		const store = createWindowStateStore(file);
		expect(store.read()).toBeNull();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createWindowStateStore：write 后 read 完整返回（含 maximized 标记）", () => {
	const dir = mkdtempSync(join(tmpdir(), "win-state-"));
	try {
		const file = join(dir, "window_state.json");
		const store = createWindowStateStore(file);
		const state = { x: 120, y: 90, width: 1280, height: 860, maximized: true };
		store.write(state);
		expect(store.read()).toEqual(state);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 屏内校验（恢复前把损坏/跑丢的状态拦下来，回退默认值）─────────

test("sanitizeWindowState：合法且在屏内 → 原样返回", () => {
	const s = sanitizeWindowState(
		{ x: 100, y: 80, width: 1280, height: 860, maximized: false },
		DISPLAY,
	);
	expect(s).toEqual({ x: 100, y: 80, width: 1280, height: 860, maximized: false });
});

test("sanitizeWindowState：最大化标记被保留（与 bounds 独立）", () => {
	const s = sanitizeWindowState(
		{ x: 100, y: 80, width: 1280, height: 860, maximized: true },
		DISPLAY,
	);
	expect(s?.maximized).toBe(true);
});

test("sanitizeWindowState：非对象输入（null）→ null", () => {
	expect(sanitizeWindowState(null, DISPLAY)).toBeNull();
});

test("sanitizeWindowState：字段缺失或非数字 → null", () => {
	expect(
		sanitizeWindowState({ y: 80, width: 1280, height: 860 }, DISPLAY),
	).toBeNull();
	expect(
		sanitizeWindowState(
			{ x: "100", y: 80, width: 1280, height: 860 },
			DISPLAY,
		),
	).toBeNull();
});

test("sanitizeWindowState：宽高非正数 → null", () => {
	expect(
		sanitizeWindowState({ x: 0, y: 0, width: 0, height: 860 }, DISPLAY),
	).toBeNull();
	expect(
		sanitizeWindowState({ x: 0, y: 0, width: 1280, height: -860 }, DISPLAY),
	).toBeNull();
});

test("sanitizeWindowState：完全在屏外（拔掉副屏后残留坐标）→ null", () => {
	expect(
		sanitizeWindowState(
			{ x: 5000, y: 2000, width: 1280, height: 860 },
			DISPLAY,
		),
	).toBeNull();
});

test("sanitizeWindowState：部分拖出屏外（用户有意拖到边缘）→ 保留", () => {
	const s = sanitizeWindowState(
		{ x: 1800, y: 80, width: 1280, height: 860, maximized: false },
		DISPLAY,
	);
	expect(s).not.toBeNull();
});

test("sanitizeWindowState：副屏负坐标 → 保留", () => {
	const displays = [
		{ bounds: { x: -1280, y: 0, width: 1280, height: 1024 } },
		{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
	];
	const s = sanitizeWindowState(
		{ x: -1200, y: 20, width: 1280, height: 860, maximized: false },
		displays,
	);
	expect(s).not.toBeNull();
});

test("sanitizeWindowState：拿不到显示器列表 → 只做形状校验，不误杀", () => {
	const s = sanitizeWindowState(
		{ x: 100, y: 80, width: 1280, height: 860, maximized: false },
		undefined,
	);
	expect(s).toEqual({ x: 100, y: 80, width: 1280, height: 860, maximized: false });
	expect(
		sanitizeWindowState({ y: 80, width: 1280, height: 860 }, []),
	).toBeNull();
});
