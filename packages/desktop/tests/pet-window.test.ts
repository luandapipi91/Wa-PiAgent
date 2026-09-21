// 桌面宠物窗口：显示器信息转换与配置文件读写的单元测试。
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectScreens,
	createConfigStore,
} from "../src/pet-window.cjs";

test("collectScreens：单屏 → virt 用 bounds、screens 用 workArea", () => {
	const displays = [
		{
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			workArea: { x: 0, y: 25, width: 1920, height: 1055 },
		},
	];
	const { virt, screens } = collectScreens(displays);
	expect(virt).toEqual({ l: 0, t: 0, r: 1920, b: 1080 });
	expect(screens).toEqual([{ l: 0, t: 25, r: 1920, b: 1080 }]);
});

test("collectScreens：多屏含负坐标 → virt 取各屏 bounds 并集", () => {
	const displays = [
		{
			bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
			workArea: { x: -1280, y: 0, width: 1280, height: 1000 },
		},
		{
			bounds: { x: 0, y: 0, width: 2560, height: 1440 },
			workArea: { x: 0, y: 0, width: 2560, height: 1410 },
		},
	];
	const { virt, screens } = collectScreens(displays);
	expect(virt).toEqual({ l: -1280, t: 0, r: 2560, b: 1440 });
	expect(screens).toHaveLength(2);
	expect(screens[0]).toEqual({ l: -1280, t: 0, r: 0, b: 1000 });
});

test("collectScreens：拿不到显示器列表 → 回落到固定虚拟屏，不抛异常", () => {
	const { virt, screens } = collectScreens(undefined);
	expect(virt.r).toBeGreaterThan(0);
	expect(screens).toEqual([virt]);
});

test("createConfigStore：文件不存在 → 空配置，不抛异常", () => {
	const dir = mkdtempSync(join(tmpdir(), "guagua-cfg-"));
	try {
		const store = createConfigStore(join(dir, "guagua_config.json"));
		expect(store.read()).toEqual({});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createConfigStore：set 合并 scale/wander/pos 并落盘", () => {
	const dir = mkdtempSync(join(tmpdir(), "guagua-cfg-"));
	try {
		const file = join(dir, "guagua_config.json");
		const store = createConfigStore(file);
		store.set({ scale: 1.25, wander: false, pos: { x: 120, y: 340 } });
		store.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			scale: 1.25,
			wander: false,
			pos: { x: 120, y: 340 },
		});
		// 再写一次只改 wander，未提供的字段保留
		store.set({ wander: true });
		store.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			scale: 1.25,
			wander: true,
			pos: { x: 120, y: 340 },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createConfigStore：非法值忽略（不写坏配置），非对象入参不抛异常", () => {
	const dir = mkdtempSync(join(tmpdir(), "guagua-cfg-"));
	try {
		const file = join(dir, "guagua_config.json");
		const store = createConfigStore(file);
		store.set({ scale: 1.1 });
		store.set({ scale: "abc", wander: "yes", pos: { x: Number.NaN, y: 3 } });
		store.set(null);
		store.flush();
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ scale: 1.1 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createConfigStore：节流写盘（delayMs 内多次 set 只写一次）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "guagua-cfg-"));
	try {
		const file = join(dir, "guagua_config.json");
		const store = createConfigStore(file, { delayMs: 50 });
		store.set({ scale: 1.1 });
		store.set({ scale: 1.2 });
		store.set({ scale: 1.3 });
		expect(() => readFileSync(file, "utf8")).toThrow();
		await new Promise((r) => setTimeout(r, 120));
		expect(JSON.parse(readFileSync(file, "utf8")).scale).toBe(1.3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
