// 代码块行容器与「token 胶囊行」的类名冲突防护（回归锁）。
//
// 背景：prism-react-renderer 的 getLineProps 给代码块每一行输出 class="token-line"，
// 而会话头部 token 统计胶囊也用 .token-line 做「标签 + 数值」的行容器
// （display:inline-flex + align-items:center）。后者叠到代码行上会把行号垂直居中到
// 多行文本的中间，序号与首行错位。修复是在代码卡片作用域内把 .token-line 复位为 block。
//
// 这两条断言互为反锁：删掉作用域复位 → 第一条红；把胶囊的 flex 规则改掉 → 第二条红。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** 取一段 CSS 里第一条命中选择器规则的声明块（到下一个 } 为止） */
function ruleOf(source: string, selector: string): string {
	const idx = source.indexOf(selector);
	expect(idx).toBeGreaterThanOrEqual(0);
	return source.slice(idx, source.indexOf("}", idx));
}

/** 胶囊那条全局规则的选择器行首锚定查找（避免命中作用域规则尾部） */
function globalRuleOf(source: string, selector: string): string {
	const m = new RegExp(`^\\${selector.charAt(0)}${selector.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m").exec(
		source,
	);
	expect(m).not.toBeNull();
	const idx = m!.index;
	return source.slice(idx, source.indexOf("}", idx));
}

test("代码块行容器复位为块级（不被胶囊的 flex 规则居中）", () => {
	const rule = ruleOf(css, '[data-testid="code-block-card"] .token-line {');
	expect(rule).toContain("display: block");
	// 必须是作用域规则，不能是全局 .token-line —— 全局改会连带改坏胶囊布局
	expect(css).not.toMatch(/^\.token-line\s*\{[^}]*display:\s*block/m);
});

test("token 胶囊的行容器仍是 flex 行（作用域复位不得波及）", () => {
	// 行首锚定：.token-line 作为选择器出现（而非嵌在作用域规则尾部）
	const rule = globalRuleOf(css, ".token-line");
	expect(rule).toContain("display: inline-flex");
	expect(rule).toContain("align-items: center");
});
