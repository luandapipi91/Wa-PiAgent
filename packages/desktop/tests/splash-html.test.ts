// splash-html.cjs 单元测试。
// 需求：端口自愈失败时，启动页错误态显示「换端口启动」+「退出」按钮（替换原「重启应用」）。
import { test, expect } from "bun:test";
import { buildSplashHTML } from "../src/util/splash-html.cjs";

test("splash HTML 包含换端口启动按钮", () => {
	const html = buildSplashHTML({});
	expect(html).toContain('id="switch-port-btn"');
	expect(html).toContain("换端口启动");
});

test("splash HTML 包含退出按钮", () => {
	const html = buildSplashHTML({});
	expect(html).toContain('id="quit-btn"');
	expect(html).toContain("退出");
});

test("splash HTML 不再包含重启应用按钮（被换端口启动替代）", () => {
	const html = buildSplashHTML({});
	expect(html).not.toContain('id="restart-btn"');
	expect(html).not.toContain("重启应用");
});

test("splash HTML script 定义 __showActions（控制按钮显隐）", () => {
	const html = buildSplashHTML({});
	expect(html).toContain("__showActions");
});

test("splash HTML script 的换端口按钮点击走 waPiApp.switchPortStart", () => {
	const html = buildSplashHTML({});
	expect(html).toContain("switchPortStart");
});

test("splash HTML script 的退出按钮点击走 waPiApp.quit", () => {
	const html = buildSplashHTML({});
	expect(html).toContain("quit");
});

test("splash HTML 按钮并排（flex-direction:row，不换行）", () => {
	const html = buildSplashHTML({});
	expect(html).toMatch(/\.actions\{[^}]*flex-direction:row/);
	expect(html).not.toMatch(/\.actions\{[^}]*flex-direction:column/);
});
