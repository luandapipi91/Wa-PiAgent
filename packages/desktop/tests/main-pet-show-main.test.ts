import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

// 点击宠物唤回主窗口时，窗口必须被提到最前（用户报告：唤醒后如果窗口在下面，不会置顶）。
// 根因：宠物窗口是 panel（NSPanel），它的点击不会激活本应用；只 show() + focus() 时
// 应用仍在后台，窗口就会被其它应用盖住。所以这条路径必须显式强制激活应用。
test("pet-window.cjs：pet:show-main 不得用 isVisible 守卫（被遮挡时也要能置顶）", () => {
	const src = readFileSync(join(SRC, "pet-window.cjs"), "utf8");
	const i = src.indexOf('ipcMain.on("pet:show-main"');
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, i + 320);
	expect(body).toContain("onShowMain");
	// 不能用「窗口已可见」当跳过条件：可见但被其它应用盖住时同样需要置顶
	expect(body).not.toContain("isVisible()");
});

test("main.cjs：点击宠物唤回主窗口时必须强制激活应用（否则窗口不会置顶）", () => {
	const src = readFileSync(join(SRC, "main.cjs"), "utf8");
	const i = src.indexOf("onShowMain:");
	expect(i).toBeGreaterThan(0);
	const body = src.slice(i, i + 420);
	expect(body).toContain("activateApp()");
	expect(body).toContain('app.focus({ steal: true })');
	// panel 是 macOS 的窗口类型，强制激活也限定在该平台
	expect(body).toContain("darwin");
});
