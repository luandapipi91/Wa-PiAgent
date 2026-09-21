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
