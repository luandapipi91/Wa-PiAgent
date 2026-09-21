// 桌面宠物：preload 桥、页面增补点、主进程接线、主窗口桥的源码契约测试。
// main.cjs / pet-preload.cjs 顶层有 require("electron") 副作用，无法直接 import，
// 沿用 tests/web-preferences.test.ts 的读源码断言方式锁定契约。
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

test("pet-preload.cjs：暴露 guaguaHost 全部约定接口（含新增穿透与庆祝回调）", () => {
	const preload = read("pet-preload.cjs");
	expect(preload).toContain('exposeInMainWorld("guaguaHost"');
	for (const member of [
		"moveWindow:",
		"setWindowSize:",
		"getCursorPos:",
		"getScreenInfo:",
		"saveConfig:",
		"loadConfig:",
		"setClickThrough:",
		"close:",
		"onCelebrate:",
	]) {
		expect(preload).toContain(member);
	}
	// 频道名与主进程一致
	for (const channel of [
		"pet:move",
		"pet:size",
		"pet:cursor",
		"pet:screens",
		"pet:save-config",
		"pet:load-config",
		"pet:click-through",
		"pet:close",
		"petwin:celebrate",
	]) {
		expect(preload).toContain(channel);
	}
});

test("pet-preload.cjs：屏幕信息与配置必须同步读取（sendSync + returnValue 回填）", () => {
	const preload = read("pet-preload.cjs");
	expect(preload).toContain('ipcRenderer.sendSync("pet:screens")');
	expect(preload).toContain('ipcRenderer.sendSync("pet:load-config")');
});

test("pet.html：交付件已就位且增补点齐全（穿透判定 / 位置记忆 / 庆祝回调）", () => {
	const htmlPath = join(SRC, "assets", "pet.html");
	expect(existsSync(htmlPath)).toBe(true);
	const html = readFileSync(htmlPath, "utf8");

	// 交付件原样保留的基座
	expect(html).toContain("BASE_W = 260");
	expect(html).toContain("function startCelebrate()");
	expect(html).toContain("body.transparent-host");

	// 增补 1：点击穿透（独立宿主光标 + 命中判定 + 宿主接口调用）
	expect(html).toContain("hostGp");
	expect(html).toContain("function hitTest(");
	expect(html).toContain("function checkClickThrough(");
	expect(html).toContain("host.setClickThrough(");

	// 增补 2：位置记忆（保存带 pos、启动读取 pos 并 clamp）
	expect(html).toContain("pos: { x: Math.round(st.fx), y: Math.round(st.fy) }");
	expect(html).toContain("cfg.pos");
	expect(html).toContain("function savePosIfMoved(");

	// 增补 3：庆祝回调注册
	expect(html).toContain("host.onCelebrate(");
});

test("pet.html：透明宿主下页面背景透明（嵌入说明的硬要求）", () => {
	const html = readFileSync(join(SRC, "assets", "pet.html"), "utf8");
	expect(html).toContain("body.transparent-host { background: transparent; }");
	expect(html).toContain('document.body.classList.add("transparent-host")');
});
