// 主题 token 契约测试：直接读 styles.css 文本，锁住
// 1) body 字体族必须走 --font-ui 变量
// 2) :root 声明 --font-ui 默认值
// 3) 后续任务追加：三套新主题块完整性、块顺序、装饰层契约
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

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

test("主题块 cyber 完整声明全部必需 token", () => {
	assertThemeComplete("cyber");
});

test("主题块 cyber 位于所有 data-accent 规则之后", () => {
	const lastAccent = css.lastIndexOf('[data-accent="');
	expect(css.indexOf(':root[data-theme="cyber"]')).toBeGreaterThan(lastAccent);
});

test("赛博扫描线有动画，且 prefers-reduced-motion 下关闭", () => {
	const tail = css.slice(css.indexOf(':root[data-theme="cyber"]'));
	expect(tail).toContain("@keyframes wa-scan");
	expect(tail).toMatch(
		/prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none/
	);
});

test("赛博扫描线装饰层不拦截鼠标事件", () => {
	const overlay = ruleBody(':root[data-theme="cyber"] body::before');
	expect(overlay).toContain("pointer-events: none");
});

test("五套风格化主题收敛 Tailwind 内置圆角刻度（2xl / 10px）到 --rounded-lg", () => {
	const tail = css.slice(css.indexOf(':root[data-theme="newspaper"]'));
	for (const theme of ["newspaper", "pixel", "cyber", "gilded", "tactical"]) {
		expect(tail).toContain(`:root[data-theme="${theme}"] .rounded-2xl`);
		expect(tail).toContain(`:root[data-theme="${theme}"] .rounded-\\[10px\\]`);
	}
	expect(tail).toContain("border-radius: var(--rounded-lg);");
});

test("五套风格化主题把圆形按钮改成方角（头像等 div 不受影响）", () => {
	const tail = css.slice(css.indexOf(':root[data-theme="newspaper"]'));
	for (const theme of ["newspaper", "pixel", "cyber", "gilded", "tactical"]) {
		expect(tail).toContain(`:root[data-theme="${theme}"] button.rounded-full`);
	}
});

test("三套新主题声明 --fill-muted（禁用/次要填充专用，与 hairline-strong 强分隔线分离）", () => {
	for (const theme of ["newspaper", "pixel", "cyber"]) {
		expect(themeBlock(theme)).toContain("--fill-muted:");
	}
	// 浅色与深色补齐同一 token，保证禁用态观感零回归
	expect(ruleBody(":root {")).toContain("--fill-muted:");
	expect(themeBlock("dark")).toContain("--fill-muted:");
});

test("填充类用法不再借用 hairline-strong（避免新主题下禁用态变成高对比色块）", () => {
	const files = readdirSync(new URL("../src", import.meta.url), {
		recursive: true,
		encoding: "utf8",
	}) as string[];
	const offenders: string[] = [];
	for (const f of files) {
		if (!/\.(tsx|ts)$/.test(f) || f.endsWith(".test.tsx") || f.endsWith(".test.ts")) continue;
		const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
		if (/bg-hairline-strong|bg-\[var\(--hairline-strong\)\]/.test(text)) offenders.push(f);
	}
	expect(offenders).toEqual([]);
});

test("主题块 gilded 完整声明全部必需 token", () => {
	assertThemeComplete("gilded");
});

test("主题块 gilded 位于所有 data-accent 规则之后", () => {
	const lastAccent = css.lastIndexOf('[data-accent="');
	expect(css.indexOf(':root[data-theme="gilded"]')).toBeGreaterThan(lastAccent);
});

test("鎏金主题是浅色归类：color-scheme 为 light", () => {
	expect(themeBlock("gilded")).toContain("color-scheme: light");
});

// 侧栏作用域必须自成一格深色：画布/面板、描边/填充、文字、强调色四组全量覆盖。
// 漏任何一个都会在深底上留下浅色主题的取值（如漏 --text-tertiary 就是深灰字压深黑底）。
const SIDEBAR_DARK_TOKENS = [
	"color-scheme",
	"--canvas",
	"--surface",
	"--surface-elevated",
	"--surface-hover",
	"--hairline",
	"--hairline-strong",
	"--fill-muted",
	"--text-primary",
	"--text-secondary",
	"--text-tertiary",
	"--accent",
	"--accent-soft",
	"--on-accent",
];

const SIDEBAR_SCOPE = ':root[data-theme="gilded"] [data-testid="sidebar"]';

test("鎏金主题为侧栏定义了深色作用域（两段式结构）", () => {
	const scope = ruleBody(SIDEBAR_SCOPE);
	for (const token of SIDEBAR_DARK_TOKENS) {
		expect(scope).toContain(`${token}:`);
	}
	expect(scope).toContain("color-scheme: dark");
});

test("侧栏作用域块位于鎏金主题主块之后（同主题从属规则）", () => {
	const themeIndex = css.indexOf(':root[data-theme="gilded"] {');
	const scopeIndex = css.indexOf(SIDEBAR_SCOPE);
	expect(themeIndex).toBeGreaterThan(-1);
	expect(scopeIndex).toBeGreaterThan(themeIndex);
});
