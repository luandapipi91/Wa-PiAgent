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
