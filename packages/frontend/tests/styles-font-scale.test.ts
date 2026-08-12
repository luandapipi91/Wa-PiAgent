import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// styles.css 的「文字大小缩放」区覆盖 Tailwind rem 字号类挂 --font-scale；
// markdown 排版正文（.prose-sm，来自 @tailwindcss/typography）固定 0.875rem，
// 若不覆盖则不随系统设置>文字大小变化（回归：聊天窗口 markdown 正文不跟随）。
// 只覆盖 .prose-sm 不动 .prose 基类（TextBlock/ask 预览靠 .text-sm 覆盖缩放）。
const css = readFileSync(
	join(import.meta.dir, "..", "src", "styles.css"),
	"utf8",
);

test(".prose-sm（markdown 正文）字号跟随 --font-scale", () => {
	expect(css).toContain(
		".prose-sm {\n\tfont-size: calc(0.875rem * var(--font-scale));\n}",
	);
});
