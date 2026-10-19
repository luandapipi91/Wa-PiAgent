import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// styles.css 的「文字大小缩放」区覆盖 Tailwind rem 字号类挂 --font-scale；
// markdown 排版正文（.prose-sm，来自 @tailwindcss/typography）固定 0.875rem，
// 若不覆盖则不随系统设置>文字大小变化（回归：聊天窗口 markdown 正文不跟随）。
// 只覆盖 .prose-sm 不动 .prose 基类（统一 markdown 组件的容器/ask 预览靠 .text-sm 覆盖缩放）。
const css = readFileSync(
	join(import.meta.dir, "..", "src", "styles.css"),
	"utf8",
).replace(/\r\n/g, "\n"); // 归一化 CRLF→LF：仓库 styles.css 可能是 CRLF，断言用 LF，避免行尾差异导致误判

test(".prose-sm（markdown 正文）字号跟随 --font-scale", () => {
	expect(css).toContain(
		".prose-sm {\n\tfont-size: calc(0.875rem * var(--font-scale));\n}",
	);
});

// markdown 主题配色必须挂在 .md-body 上（而不只认 data-testid="text-block"）：
// 弹窗/回收站这类容器传 testId=null，只认 testid 时拿不到主题变量，
// typography 的浅色默认色在暗色背景上就是看不见的字。
test(".md-body 命中 markdown 主题覆盖（暗色/浅色都跟随主题）", () => {
  expect(css).toContain(
    ':is([data-testid="text-block"], .md-body).prose-sm',
  );
  expect(css).toContain("--tw-prose-body: var(--text-primary)");
});


