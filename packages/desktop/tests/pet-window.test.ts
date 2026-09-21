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

// ---- 窗口生命周期与 IPC 契约（注入 mock electron） ----
import { setupPetWindow } from "../src/pet-window.cjs";

const PET_HTML_TAIL = join("assets", "pet.html");
const PET_PRELOAD_TAIL = "pet-preload.cjs";

function makeHarness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const listeners = new Map<string, (...args: any[]) => any>();
	const calls: Array<[string, any]> = [];
	const dir = mkdtempSync(join(tmpdir(), "guagua-pet-"));
	const configFile = join(dir, "guagua_config.json");

	class FakeWindow {
		webContents = {
			send: (channel: string, payload: any) =>
				calls.push([`send:${channel}`, payload]),
			once: (_event: string, _cb: () => void) => {},
		};
		options: any;
		destroyed = false;
		shown = 0;
		on(_event: string, _cb: () => void) {}
		constructor(options: any) {
			this.options = options;
			calls.push(["newWindow", options]);
		}
		loadFile(p: string) {
			calls.push(["loadFile", p]);
		}
		show() {
			this.shown += 1;
			calls.push(["show", true]);
		}
		isVisible() {
			return true;
		}
		hide() {
			calls.push(["hide", true]);
		}
		destroy() {
			this.destroyed = true;
			calls.push(["destroy", true]);
		}
		close() {
			this.destroyed = true;
			calls.push(["close", true]);
		}
		setPosition(x: number, y: number) {
			calls.push(["setPosition", { x, y }]);
		}
		setContentSize(w: number, h: number) {
			calls.push(["setContentSize", { w, h }]);
		}
		setIgnoreMouseEvents(flag: boolean, opts?: any) {
			calls.push(["setIgnoreMouseEvents", { flag, opts }]);
		}
		isDestroyed() {
			return this.destroyed;
		}
	}

	const created: FakeWindow[] = [];
	const BrowserWindow = function (options: any) {
		const w = new FakeWindow(options);
		created.push(w);
		return w;
	} as any;

	const ipcMain = {
		on: (name: string, fn: (...args: any[]) => any) => listeners.set(name, fn),
		handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
	};
	const screen = {
		getPrimaryDisplay: () => ({
			workArea: { x: 0, y: 0, width: 1920, height: 1080 },
		}),
		getAllDisplays: () => [
			{
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				workArea: { x: 0, y: 25, width: 1920, height: 1055 },
			},
		],
		getCursorScreenPoint: () => ({ x: 777, y: 888 }),
	};

	const mainWindow = { webContents: { id: "main" } };
	const closed: any[] = [];
	const pet = setupPetWindow({
		BrowserWindow,
		ipcMain,
		screen,
		log: { info: () => {}, error: () => {} },
		configFile,
		getMainWindow: () => mainWindow,
		onPetClosed: () => closed.push("closed"),
	});
	return {
		pet,
		handlers,
		listeners,
		calls,
		created,
		closed,
		configFile,
		dir,
		mainSender: { sender: mainWindow.webContents },
	};
}

const petSender = (harness: ReturnType<typeof makeHarness>) => ({
	sender: harness.pet.getWindow()?.webContents,
});

test("注册全部宠物 IPC 频道（on 与 handle 各就各位）", () => {
	const h = makeHarness();
	try {
		expect([...h.listeners.keys()].sort()).toEqual(
			[
				"pet:click-through",
				"pet:close",
				"pet:load-config",
				"pet:move",
				"pet:save-config",
				"pet:screens",
				"pet:size",
				"petwin:celebrate",
				"petwin:set-enabled",
			].sort(),
		);
		expect([...h.handlers.keys()]).toEqual(["pet:cursor"]);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("setEnabled(true)：按约定参数建窗并加载 pet.html、首帧后显示", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		const options = h.created[0].options;
		expect(options.transparent).toBe(true);
		expect(options.frame).toBe(false);
		expect(options.resizable).toBe(false);
		expect(options.skipTaskbar).toBe(true);
		expect(options.hasShadow).toBe(false);
		expect(options.useContentSize).toBe(true);
		expect(options.width).toBe(260);
		expect(options.height).toBe(258);
		// 普通窗口层级：不得置顶
		expect(options.alwaysOnTop).toBeUndefined();
		expect(options.webPreferences.preload).toContain(PET_PRELOAD_TAIL);
		expect(options.webPreferences.contextIsolation).toBe(true);
		expect(options.webPreferences.nodeIntegration).toBe(false);
		expect(options.webPreferences.sandbox).toBe(false);
		expect(String(h.calls.find((c) => c[0] === "loadFile")![1])).toContain(
			PET_HTML_TAIL,
		);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("setEnabled：true 建窗、false 销窗、重复 true 不重建", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		h.pet.setEnabled(true);
		expect(h.created).toHaveLength(1);
		h.pet.setEnabled(false);
		expect(h.created[0].destroyed).toBe(true);
		expect(h.closed).toHaveLength(0); // 开关关闭不算「用户点关闭」，不回执
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("petwin:set-enabled 只接受主窗口请求（宠物窗口自身不得建窗）", () => {
	const h = makeHarness();
	try {
		h.listeners.get("petwin:set-enabled")!(petSender(h), true);
		h.listeners.get("petwin:set-enabled")!(petSender(h), false);
		expect(h.created).toHaveLength(0);
		h.listeners.get("petwin:set-enabled")!(h.mainSender, true);
		expect(h.created).toHaveLength(1);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("pet:move / pet:size 只接受宠物窗口，并透传为 setPosition / setContentSize", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		const sender = petSender(h);
		h.listeners.get("pet:move")!(h.mainSender, 10, 20);
		expect(h.calls.some((c) => c[0] === "setPosition")).toBe(false);
		h.listeners.get("pet:move")!(sender, 10, 20);
		h.listeners.get("pet:size")!(sender, 390, 387);
		expect(h.calls.find((c) => c[0] === "setPosition")![1]).toEqual({
			x: 10,
			y: 20,
		});
		expect(h.calls.find((c) => c[0] === "setContentSize")![1]).toEqual({
			w: 390,
			h: 387,
		});
		// 非数字入参忽略
		h.listeners.get("pet:move")!(sender, "abc", null);
		expect(h.calls.filter((c) => c[0] === "setPosition")).toHaveLength(1);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("pet:screens / pet:load-config 同步回填 returnValue（页面用 sendSync 读取）", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		const sender = petSender(h);
		const screensEvent: any = { ...sender };
		h.listeners.get("pet:screens")!(screensEvent);
		expect(screensEvent.returnValue).toEqual({
			virt: { l: 0, t: 0, r: 1920, b: 1080 },
			screens: [{ l: 0, t: 25, r: 1920, b: 1080 }],
		});
		const cfgEvent: any = { ...sender };
		h.listeners.get("pet:load-config")!(cfgEvent);
		expect(cfgEvent.returnValue).toEqual({});
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("pet:cursor 返回屏幕光标坐标", () => {
	const h = makeHarness();
	try {
		expect(h.handlers.get("pet:cursor")!()).toEqual({ x: 777, y: 888 });
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("pet:save-config 落盘（flush 后文件内容一致）", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		h.listeners.get("pet:save-config")!(petSender(h), {
			scale: 1.5,
			wander: true,
			pos: { x: 300, y: 400 },
		});
		h.pet.flush();
		expect(JSON.parse(readFileSync(h.configFile, "utf8"))).toEqual({
			scale: 1.5,
			wander: true,
			pos: { x: 300, y: 400 },
		});
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("pet:click-through 映射到 setIgnoreMouseEvents（macOS/Win 带 forward）", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		const sender = petSender(h);
		h.listeners.get("pet:click-through")!(sender, true);
		expect(h.calls.find((c) => c[0] === "setIgnoreMouseEvents")![1]).toEqual({
			flag: true,
			opts: { forward: true },
		});
		h.listeners.get("pet:click-through")!(sender, false);
		expect(
			h.calls.filter((c) => c[0] === "setIgnoreMouseEvents").at(-1)![1],
		).toEqual({
			flag: false,
			opts: undefined,
		});
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("Linux 下不传 forward（平台不支持该参数）", () => {
	const dir = mkdtempSync(join(tmpdir(), "guagua-pet-"));
	try {
		const calls: any[] = [];
		class W {
			webContents = {
				send: () => {},
				once: () => {},
			};
			on() {}
			loadFile() {}
			show() {}
			destroy() {}
			isDestroyed() {
				return false;
			}
			setIgnoreMouseEvents(flag: boolean, opts?: any) {
				calls.push({ flag, opts });
			}
		}
		const listeners = new Map<string, any>();
		const pet = setupPetWindow({
			BrowserWindow: function () {
				return new W() as any;
			} as any,
			ipcMain: {
				on: (n: string, fn: any) => listeners.set(n, fn),
				handle: () => {},
			},
			screen: {
				getPrimaryDisplay: () => ({
					workArea: { x: 0, y: 0, width: 800, height: 600 },
				}),
				getAllDisplays: () => [],
				getCursorScreenPoint: () => ({ x: 0, y: 0 }),
			},
			log: { info: () => {}, error: () => {} },
			configFile: join(dir, "guagua_config.json"),
			getMainWindow: () => ({ webContents: { id: 1 } }),
			onPetClosed: () => {},
			platform: "linux",
		});
		pet.setEnabled(true);
		listeners.get("pet:click-through")!(
			{ sender: pet.getWindow().webContents },
			true,
		);
		expect(calls).toEqual([{ flag: true, opts: undefined }]);
		// 关掉穿透不带 forward 参数
		listeners.get("pet:click-through")!(
			{ sender: pet.getWindow().webContents },
			false,
		);
		expect(calls[1]).toEqual({ flag: false, opts: undefined });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("销毁宠物窗口走正常关闭流程（close），不用强制 destroy", () => {
	// destroy() 的语义是「强制销毁、不触发关闭流程」，会让系统可见性变化事件在对象
	// 已释放后才被 Electron 内部钩子处理 → 主进程抛 "Object has been destroyed"（visibilityChanged）。
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		h.pet.setEnabled(false);
		expect(h.calls.some((c) => c[0] === "close")).toBe(true);
		expect(h.calls.some((c) => c[0] === "destroy")).toBe(false);
		// 先 hide 再 close（降低与系统可见性/遮挡通知的竞态）
		const hideIdx = h.calls.findIndex((c) => c[0] === "hide");
		const closeIdx = h.calls.findIndex((c) => c[0] === "close");
		expect(hideIdx).toBeGreaterThanOrEqual(0);
		expect(hideIdx).toBeLessThan(closeIdx);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("右键「关闭桌面宠物」同样走 close，并回执主窗口", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		h.listeners.get("pet:close")!(petSender(h));
		expect(h.calls.some((c) => c[0] === "close")).toBe(true);
		expect(h.calls.some((c) => c[0] === "destroy")).toBe(false);
		expect(h.closed).toHaveLength(1);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});

test("退出清理同样走 close（不强制销毁）", () => {
	const h = makeHarness();
	try {
		h.pet.setEnabled(true);
		h.pet.dispose();
		expect(h.calls.some((c) => c[0] === "close")).toBe(true);
		expect(h.calls.some((c) => c[0] === "destroy")).toBe(false);
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});
