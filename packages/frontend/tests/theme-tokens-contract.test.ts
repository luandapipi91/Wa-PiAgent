// 主题 token 契约测试：直接读 styles.css 文本，锁住
// 1) body 字体族必须走 --font-ui 变量
// 2) :root 声明 --font-ui 默认值
// 3) 后续任务追加：三套新主题块完整性、块顺序、装饰层契约
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** 取指定选择器的规则块声明体（按选择器字面量定位，块内不允许再嵌套大括号） */
function ruleBody(selector: string): string {
	const start = css.indexOf(selector);
	if (start < 0) throw new Error(`缺少规则 ${selector}`);
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	return css.slice(open + 1, close);
}

/** 取 :root[data-theme="X"] 变量块 */
function themeBlock(name: string): string {
	return ruleBody(`:root[data-theme="${name}"]`);
}

test("body 字体族走 --font-ui 变量", () => {
	const bodyRule = ruleBody("body {");
	expect(bodyRule).toContain("font-family: var(--font-ui)");
});

test(":root 声明 --font-ui 默认值（MiSans 栈）", () => {
	const rootBlock = ruleBody(":root {");
	expect(rootBlock).toContain("--font-ui:");
	expect(rootBlock).toContain("MiSans");
});

// 供后续任务在账本里引用的最小变量全量清单（三套新主题必须完整声明）
const REQUIRED_TOKENS = [
	"color-scheme",
	"--canvas",
	"--canvas-grad-end",
	"--surface",
	"--surface-elevated",
	"--surface-hover",
	"--hairline",
	"--hairline-strong",
	"--text-primary",
	"--text-secondary",
	"--text-tertiary",
	"--brand",
	"--brand-soft",
	"--on-brand",
	"--accent",
	"--accent-soft",
	"--on-accent",
	"--success",
	"--success-soft",
	"--info",
	"--info-soft",
	"--warning",
	"--warning-soft",
	"--danger",
	"--danger-soft",
	"--on-danger",
	"--rounded-sm",
	"--rounded-md",
	"--rounded-lg",
	"--rounded-xl",
	"--rounded-pill",
	"--shadow-sm",
	"--shadow-md",
	"--shadow-lg",
	"--font-ui",
];

// 三套新主题必须自洽：不能依赖浅色/强调色规则兜底。
// 每个任务只断言自己那套（pixel/cyber 在后续任务追加）。
function assertThemeComplete(theme: string) {
	const block = themeBlock(theme);
	for (const token of REQUIRED_TOKENS) {
		expect(block).toContain(`${token}:`);
	}
}

test("主题块 newspaper 完整声明全部必需 token", () => {
	assertThemeComplete("newspaper");
});

test("主题块 newspaper 位于所有 data-accent 规则之后（强调色由主题自带）", () => {
	const lastAccent = css.lastIndexOf('[data-accent="');
	expect(css.indexOf(':root[data-theme="newspaper"]')).toBeGreaterThan(lastAccent);
});

test("深色块已补齐 info/info-soft/on-danger 缺口", () => {
	const block = themeBlock("dark");
	for (const token of ["--info", "--info-soft", "--on-danger"]) {
		expect(block).toContain(`${token}:`);
	}
});

test("报纸装饰层 body::before 不拦截鼠标事件", () => {
	const overlay = ruleBody(':root[data-theme="newspaper"] body::before');
	expect(overlay).toContain("pointer-events: none");
});

test("主题块 pixel 完整声明全部必需 token", () => {
	assertThemeComplete("pixel");
});

test("主题块 pixel 位于所有 data-accent 规则之后", () => {
	const lastAccent = css.lastIndexOf('[data-accent="');
	expect(css.indexOf(':root[data-theme="pixel"]')).toBeGreaterThan(lastAccent);
});

test("像素主题字体栈保留中文与通用族回退", () => {
	const stack =
		themeBlock("pixel").match(/--font-ui:\s*([^;]+);/)?.[1] ?? "";
	expect(stack).toContain("Fusion Pixel");
	expect(stack).toContain("MiSans");
	expect(stack).toContain("monospace");
});

test("声明 Fusion Pixel 的 @font-face 且指向本地字体文件", () => {
	expect(css).toContain('font-family: "Fusion Pixel"');
	expect(css).toContain('url("/fonts/fusion-pixel-12px.woff2")');
});

test("像素点阵装饰层不拦截鼠标事件", () => {
	const overlay = ruleBody(':root[data-theme="pixel"] body::before');
	expect(overlay).toContain("pointer-events: none");
});
