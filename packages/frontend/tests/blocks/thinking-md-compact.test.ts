import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 思考过程（推理草稿）紧凑排版：与聊天正文共用 .md-body markdown，但正文是正式内容、
// 草稿是短句堆叠——typography 的段落/列表 1.25em 间距（12px 字号下 16px 上下）会把
// 一条思考拆成一堆视觉孤岛（用户反馈：中间间隔太宽）。这里锁定「只压垂直间距、
// 且只作用于 .md-body.thinking-md」这一契约，聊天正文的段间距保持不变。
const css = readFileSync(
	join(import.meta.dir, "..", "..", "src", "styles.css"),
	"utf8",
).replace(/\r\n/g, "\n");

/** 取出 thinking-md 作用域的规则文本（到下一个注释区块或文件末尾） */
function thinkingBlock(): string {
	const start = css.indexOf(".md-body.thinking-md");
	expect(start).toBeGreaterThan(-1);
	return css.slice(start, start + 2000);
}

test("思考过程作用域存在（.md-body.thinking-md）", () => {
	expect(thinkingBlock()).toContain(".md-body.thinking-md");
});

test("块级元素垂直间距归零（段落/列表/引用/代码块不再吃 typography 的 1.25em）", () => {
	const block = thinkingBlock();
	expect(block).toContain("margin-top: 0;\n\tmargin-bottom: 0;");
});

test("列表项之间与列表项内段落只保留极小间距", () => {
	const block = thinkingBlock();
	// li + li：项之间的小间隙
	expect(block).toMatch(/\.md-body\.thinking-md li \+ li \{\n\tmargin-top: 0\.\d+em;/);
	// li > p：loose list 的段落不额外撑高（否则圆点与正文之间出现空行）
	expect(block).toMatch(/\.md-body\.thinking-md li > p \{\n\tmargin: 0;/);
});

test("聊天正文段间距不受影响（改动只在 thinking-md 作用域内）", () => {
	// 正文的兜底段间距规则按原样保留
	expect(css).toContain(
		':is([data-testid="text-block"], .md-body) p + p {\n\tmargin-top: 0.5em;\n}',
	);
});
