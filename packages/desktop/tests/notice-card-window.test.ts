// 通知卡片窗口：建窗参数、主屏右下角定位、生命周期三态、下行队列同步、上行事件转发的单元测试。
// mock electron 注入方式照 tests/pet-window.test.ts 先例（依赖全部经参数注入）。
// preload.cjs / notice-card.html 顶层无法直接 import（require("electron") / 浏览器页面），
// 沿用 tests/pet-assets.test.ts 的读源码断言方式锁定契约。
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNoticeCardController } from "../src/notice/notice-card-window.cjs";

const SRC = join(import.meta.dir, "..", "src");

type AnyCall = [string, any];

interface WorkArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

function makeHarness(opts: { workArea?: WorkArea } = {}) {
	const calls: AnyCall[] = [];
	const listeners = new Map<string, (...args: any[]) => any>();
	const loadCbs: Array<() => void> = [];
	const activated: any[] = [];
	const actions: any[] = [];

	class FakeWindow {
		webContents = {
			send: (channel: string, payload: any) =>
				calls.push([`send:${channel}`, payload]),
			once: (_event: string, cb: () => void) => loadCbs.push(cb),
		};
		options: any;
		destroyed = false;
		on(_event: string, _cb: (...args: any[]) => void) {}
		constructor(options: any) {
			this.options = options;
			calls.push(["newWindow", options]);
		}
		loadFile(p: string) {
			calls.push(["loadFile", p]);
		}
		setBounds(b: any) {
			calls.push(["setBounds", b]);
		}
		show() {
			calls.push(["show", true]);
		}
		showInactive() {
			calls.push(["showInactive", true]);
		}
		hide() {
			calls.push(["hide", true]);
		}
		destroy() {
			this.destroyed = true;
		}
		isDestroyed() {
			return this.destroyed;
		}
	}

	const created: FakeWindow[] = [];
	const BrowserWindow: any = function (options: any) {
		const w = new FakeWindow(options);
		created.push(w);
		return w;
	};
	const ipcMain = {
		on: (name: string, fn: (...args: any[]) => any) => listeners.set(name, fn),
	};

	const controller = createNoticeCardController({
		BrowserWindow,
		ipcMain: ipcMain as any, // mock 不实现完整 electron.IpcMain（照 notice.test.ts 先例）
		getPrimaryDisplay: () => ({
			workArea: opts.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 },
		}),
		activateApp: () => activated.push("activate"),
		onAction: (evt: any) => actions.push(evt),
	});

	const cardSender = () => ({ sender: created[0].webContents });
	// 触发 did-finish-load（mock 里 once 存下的回调）
	const fireLoad = () => loadCbs.splice(0).forEach((cb) => cb());

	return { controller, calls, listeners, created, activated, actions, cardSender, fireLoad };
}

const ITEMS = [
	{
		title: "任务完成",
		body: "「会话甲」已完成，点击查看",
		action: { type: "session", sessionId: "s1" },
		sessionId: "s1",
	},
	{ title: "发现新版本 v9.9.9", body: "点击查看新版本更新内容", action: { type: "update" } },
];

test("建窗参数照 pet-window 先例：无边框/置顶/跳过任务栏/透明/不设 focusable/show:false", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	const options = h.created[0].options;
	expect(options.frame).toBe(false);
	expect(options.alwaysOnTop).toBe(true);
	expect(options.skipTaskbar).toBe(true);
	expect(options.resizable).toBe(false);
	expect(options.transparent).toBe(true);
	expect(options.hasShadow).toBe(false);
	expect(options.useContentSize).toBe(true);
	// 建窗不自动显示：等页面就绪后 showInactive，避免空白帧
	expect(options.show).toBe(false);
	// 照 pet-window：不设 focusable:false（macOS 上有不显示风险），不抢焦点交给 showInactive
	expect(options.focusable).toBeUndefined();
	// macOS panel（NSPanel）：不参与普通窗口枚举、不进 Cmd+Tab
	expect(options.type).toBe("panel");
	// 基准尺寸 320×96
	expect(options.width).toBe(320);
	expect(options.height).toBe(96);
	expect(options.webPreferences.nodeIntegration).toBe(false);
	expect(options.webPreferences.contextIsolation).toBe(true);
	expect(options.webPreferences.sandbox).toBe(false);
	expect(String(options.webPreferences.preload)).toContain("preload.cjs");
});

test("加载 src/notice/notice-card.html（共享 preload.cjs 复用模式）", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	const load = h.calls.find((c) => c[0] === "loadFile")![1] as string;
	expect(load).toContain(join("notice", "notice-card.html"));
});

test("定位：主屏 workArea 右下角，边距 16px（320×96 卡片）", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	const bounds = h.calls.find((c) => c[0] === "setBounds")![1];
	expect(bounds).toEqual({
		x: 1920 - 320 - 16,
		y: 1080 - 96 - 16,
		width: 320,
		height: 96,
	});
	// 非零原点主屏（外接屏切为主屏等场景）同样锚定右下角
	const h2 = makeHarness({ workArea: { x: 100, y: 50, width: 1600, height: 900 } });
	h2.controller.showCard(ITEMS, 0, "light");
	expect(h2.calls.find((c) => c[0] === "setBounds")![1]).toEqual({
		x: 100 + 1600 - 320 - 16,
		y: 50 + 900 - 96 - 16,
		width: 320,
		height: 96,
	});
});

test("showCard 生命周期三态：未建按需创建、已建复用、已销毁重建", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	expect(h.created).toHaveLength(1);
	// 窗口存活 → 复用（不新建）
	h.controller.showCard(ITEMS, 1, "dark");
	expect(h.created).toHaveLength(1);
	// 已销毁 → 重建
	h.created[0].destroyed = true;
	h.controller.showCard(ITEMS, 0, "light");
	expect(h.created).toHaveLength(2);
});

test("显示不抢焦点：页面就绪后 showInactive，绝不调用 show()", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	h.fireLoad(); // did-finish-load
	expect(h.calls.filter((c) => c[0] === "showInactive")).toHaveLength(1);
	expect(h.calls.some((c) => c[0] === "show")).toBe(false);
});

test("下行 notice-card:update 载荷含 items/index/theme/count（count=条数）", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 1, "dark");
	h.fireLoad();
	const updates = h.calls.filter((c) => c[0] === "send:notice-card:update");
	expect(updates).toHaveLength(1);
	expect(updates[0][1]).toEqual({ items: ITEMS, index: 1, theme: "dark", count: 2 });
});

test("窗口复用时 showCard 直接下行 update 并再次 showInactive；hide 后可重新显示", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	h.fireLoad();
	h.controller.hide();
	expect(h.calls.filter((c) => c[0] === "hide")).toHaveLength(1);
	// 复用同一窗口：不重建，直接下行 + 显示
	h.controller.showCard(ITEMS, 1, "dark");
	expect(h.created).toHaveLength(1);
	const updates = h.calls.filter((c) => c[0] === "send:notice-card:update");
	expect(updates).toHaveLength(2);
	expect(updates[1][1]).toEqual({ items: ITEMS, index: 1, theme: "dark", count: 2 });
	expect(h.calls.filter((c) => c[0] === "showInactive")).toHaveLength(2);
});

test("页面就绪前的 showCard：载荷缓存，did-finish-load 后补发最新载荷并显示", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	expect(h.calls.some((c) => c[0] === "send:notice-card:update")).toBe(false);
	expect(h.calls.some((c) => c[0] === "showInactive")).toBe(false);
	// 页面就绪前连续两次取最新载荷（中间态不发）
	h.controller.showCard(ITEMS, 1, "dark");
	h.fireLoad();
	const updates = h.calls.filter((c) => c[0] === "send:notice-card:update");
	expect(updates).toHaveLength(1);
	expect(updates[0][1]).toEqual({ items: ITEMS, index: 1, theme: "dark", count: 2 });
	expect(h.calls.filter((c) => c[0] === "showInactive")).toHaveLength(1);
});

test("上行 card:click → 转发 onAction 并激活应用；hover/switch 只转发不激活", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	const onEvent = h.listeners.get("notice-card:event")!;
	onEvent(h.cardSender(), { type: "card:click" });
	expect(h.actions).toEqual([{ type: "card:click" }]);
	expect(h.activated).toHaveLength(1);
	onEvent(h.cardSender(), { type: "card:hover", action: "pause" });
	onEvent(h.cardSender(), { type: "card:hover", action: "resume" });
	onEvent(h.cardSender(), { type: "card:switch", dir: "prev" });
	onEvent(h.cardSender(), { type: "card:switch", dir: "next" });
	expect(h.actions).toEqual([
		{ type: "card:click" },
		{ type: "card:hover", action: "pause" },
		{ type: "card:hover", action: "resume" },
		{ type: "card:switch", dir: "prev" },
		{ type: "card:switch", dir: "next" },
	]);
	// hover / switch 不得激活应用（不抢焦点）
	expect(h.activated).toHaveLength(1);
});

test("上行只接受卡片窗口 sender（其它来源忽略）", () => {
	const h = makeHarness();
	h.controller.showCard(ITEMS, 0, "light");
	h.listeners.get("notice-card:event")!({ sender: { id: "intruder" } }, { type: "card:click" });
	expect(h.actions).toHaveLength(0);
	expect(h.activated).toHaveLength(0);
});

test("notice-card.html：单文件零依赖、桥接口与主题 class 驱动齐备", () => {
	const htmlPath = join(SRC, "notice", "notice-card.html");
	expect(existsSync(htmlPath)).toBe(true);
	const html = readFileSync(htmlPath, "utf8");
	// 桥接口与三类上行事件
	for (const marker of [
		"waPiNoticeCard",
		"sendNoticeEvent",
		"onCardUpdate",
		"card:click",
		"card:hover",
		"card:switch",
	]) {
		expect(html).toContain(marker);
	}
	// 零依赖：无外链脚本/网络引用、无 CommonJS
	expect(html).not.toContain("<script src=");
	expect(html).not.toMatch(/https?:\/\//);
	expect(html).not.toContain("require(");
	// 主题由 update 载荷驱动 class
	expect(html).toContain('"dark"');
	expect(html).toContain("classList");
});

test("preload.cjs：waPiNoticeCard 桥（上行 sendNoticeEvent / 下行 onCardUpdate，通道名与主进程一致）", () => {
	const preload = readFileSync(join(SRC, "preload.cjs"), "utf8");
	expect(preload).toContain('exposeInMainWorld("waPiNoticeCard"');
	expect(preload).toContain("sendNoticeEvent:");
	expect(preload).toContain("onCardUpdate:");
	expect(preload).toContain('"notice-card:event"');
	expect(preload).toContain('"notice-card:update"');
});
