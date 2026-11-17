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

/** 取 :root[data-theme="X"] 变量块。
 *  选择器末尾的 ` {` 是故意加的：没有它，`indexOf` 会命中首次出现的
 *  `:root[data-theme="X"] .某后代类` 这种跨主题规则，拿到的变成那条规则体，
 *  断言就跑在错的块上。带上花括号后，只能精确命中主题主块本身。 */
function themeBlock(name: string): string {
	return ruleBody(`:root[data-theme="${name}"] {`);
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

// 供各主题块契约引用的最小变量全量清单（每套风格化主题都必须完整声明）
const REQUIRED_TOKENS = [
	"color-scheme",
	"--canvas",
	"--canvas-grad-end",
	"--surface",
	"--surface-elevated",
	"--surface-hover",
	"--hairline",
	"--hairline-strong",
	"--fill-muted",
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

// 风格化主题必须自洽：不能依赖浅色/强调色规则兜底。
// 新增主题时在下方逐套加断言，不要改成遍历（选择器定位失准时单套失败更好读）。
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

test("五套风格化主题声明 --fill-muted（禁用/次要填充专用，与 hairline-strong 强分隔线分离）", () => {
	for (const theme of ["newspaper", "pixel", "cyber", "gilded", "tactical"]) {
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

test("主题块 tactical 完整声明全部必需 token", () => {
	assertThemeComplete("tactical");
});

test("主题块 tactical 位于所有 data-accent 规则之后", () => {
	const lastAccent = css.lastIndexOf('[data-accent="');
	expect(css.indexOf(':root[data-theme="tactical"]')).toBeGreaterThan(lastAccent);
});

// ===== 鎏金装饰层契约（装饰块位于侧栏作用域块之后、tactical 块之前） =====
/** 取鎏金装饰块的 CSS 文本（切片终点用 tactical 主题块，故装饰块必须排在它之前） */
function gildedDecor(): string {
	const start = css.indexOf(':root[data-theme="gilded"] [data-testid="sidebar"]');
	const end = css.indexOf(':root[data-theme="tactical"]');
	if (start < 0 || end < 0) throw new Error("鎏金/tactical 作用域锚点缺失");
	return css.slice(start, end);
}

test("鎏金装饰规则全部限定在 data-theme 作用域内", () => {
	// 取 gilded 变量块之后、tactical 块之前的所有规则文本
	const decor = gildedDecor();
	// 每个选择器行都必须以 :root[data-theme="gilded"] 开头。
	// 按逗号切开逐段断言：单行多选择器（`… .a, .b {`）整行含前缀不代表 `.b` 也在作用域内。
	const selectors = decor
		.split("\n")
		.filter((line) => /\{\s*$/.test(line.trim()) && !line.trim().startsWith("/*"))
		.map((line) => line.trim().replace(/\s*\{$/, ""))
		.flatMap((line) => line.split(","))
		.map((sel) => sel.trim());
	for (const sel of selectors) {
		expect(sel).toContain(':root[data-theme="gilded"]');
	}
});

test("鎏金装饰包含关键元素选择器", () => {
	const decor = gildedDecor();
	for (const sel of [
		'[data-testid^="sidebar-tab-"]',
		'[data-testid^="session-"]',
		'[data-testid="text-bubble"]',
		'[data-testid="composer-send"]',
		'[data-testid="explorer-aside"]',
	]) {
		expect(decor).toContain(sel);
	}
});

// ===== 战术终端装饰层契约（装饰块位于 tactical 主题块之后、文件末尾） =====
/** 取战术装饰块的 CSS 文本。切片起点钉在装饰块首条规则（侧栏会话行分隔线）上：
 *  它之前不能再有装饰规则，否则会漏检。 */
function tacticalDecor(): string {
	const start = css.indexOf(
		':root[data-theme="tactical"] [data-testid="sidebar"]',
	);
	if (start < 0) throw new Error("战术装饰块锚点缺失");
	return css.slice(start);
}

/** 提取片段里每条规则的选择器（多选择器按逗号切段）。
 *  **不能用「以 `{` 结尾的行」当选择器**：战术装饰块含 `@media (prefers-reduced-motion)`，
 *  这行同样以 `{` 结尾却不含 data-theme，按行扫会误判成缺作用域的泄漏规则。
 *  这里先剥掉 `@…{` 外壳：@ 规则自身不当作选择器，其内部规则照常参与检查
 *  （减少动效规则若写成裸 `* { transition: none }`，会泄漏到其他主题，必须也验证前缀）。
 *  顺带补上按行扫描的盲区：多行选择器组（`a,⏎b {`）此前只检查到最后一行。 */
function decorSelectors(block: string): string[] {
	return block
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/@[^{]*\{/g, "")
		.split("}")
		.flatMap((chunk) => {
			const open = chunk.indexOf("{");
			if (open < 0) return [];
			const sel = chunk.slice(0, open).trim();
			return sel ? sel.split(",").map((s) => s.trim()) : [];
		})
		.filter(Boolean);
}

test("战术装饰规则全部限定在 data-theme 作用域内（@ 规则除外）", () => {
	const selectors = decorSelectors(tacticalDecor());
	// 防空切片假绿：切片没取到规则时，下面的循环会零次通过
	expect(selectors.length).toBeGreaterThan(0);
	for (const sel of selectors) {
		expect(sel).toContain(':root[data-theme="tactical"]');
	}
});

test("战术装饰块位于战术主题变量块之后（文件末尾追加）", () => {
	const themeIndex = css.indexOf(':root[data-theme="tactical"] {');
	expect(themeIndex).toBeGreaterThan(-1);
	expect(css.indexOf(':root[data-theme="tactical"] [data-testid="sidebar"]')).toBeGreaterThan(
		themeIndex,
	);
});

test("战术装饰含水印、等宽数据与减动效规则", () => {
	const decor = tacticalDecor();
	expect(decor).toContain("CONVERSATION");
	expect(decor).toContain("tabular-nums");
	expect(decor).toContain("prefers-reduced-motion");
	// 水印是纯装饰：不参与命中，也不可被选中
	expect(decor).toContain("pointer-events: none");
});

test("战术装饰覆盖关键元素选择器", () => {
	const decor = tacticalDecor();
	for (const sel of [
		'[data-testid="agent-collapsed"]',
		'[data-testid^="sidebar-tab-"]',
		'[data-testid^="session-"]',
		'[data-testid="text-bubble"]',
		'[data-testid="composer-send"]',
		'[data-testid="explorer-aside"]',
		'[data-testid="session-status-dot"]',
	]) {
		expect(decor).toContain(sel);
	}
});

// 自绘标题栏（macOS 桌面版）：8 套主题都必须声明自己的 --titlebar-*，
// 否则切主题时窗口顶部会用上一套的底色（漏一套就会「顶部还是旧主题」）。
// 用 themeBlock 而非 ruleBody：后者按首次子串命中，会拿到跨主题的后代规则。
test("八套主题都声明标题栏配色", () => {
	for (const theme of ["dark", "newspaper", "pixel", "cyber", "gilded", "tactical"]) {
		const block = themeBlock(theme);
		expect(block, theme).toContain("--titlebar-bg");
		expect(block, theme).toContain("--titlebar-text");
		expect(block, theme).toContain("--titlebar-line");
	}
	// 浅色主题（system/light）用 :root 默认值兜底
	expect(css).toContain("--titlebar-bg: #ffffff");
});

// 缓存胶囊与数据条同属一组：它既是 .token-capsule，又是 token-capsules 的 last-child。
// 一条未限定的 `.token-capsule:last-child { border-right: 0 }` 权重比缓存自身的描边规则
// 高一层，会连带把缓存的右边框吃掉（gilded 曾如此，用户截图「缓存右边框被裁切」）。
// 所以「末尾格去右边框」这类复位规则只允许写在数据条内部。
test("token 胶囊的末尾复位规则不得匹配独立缓存胶囊", () => {
	// 先剔注释：规则说明里会引用选择器字面量，那不算规则
	const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const offenders = [...noComments.matchAll(/([^{}]*\.token-capsule:last-child[^{}]*)\{/g)]
		.map((m) => m[1].trim())
		.filter((sel) => !sel.includes("> .token-bar >"));
	expect(offenders).toEqual([]);
});

test("鎏金缓存胶囊自带四边描边，不依赖数据条末格规则", () => {
	const body = ruleBody(
		':root[data-theme="gilded"] [data-testid="token-capsules"] > .token-capsule--cache {',
	);
	expect(body).toContain("border: 1px solid");
});

test("标题栏装饰规则都在主题作用域内，不污染其它主题", () => {
	const decor = gildedDecor() + tacticalDecor();
	for (const sel of [".titlebar-wordmark", ".titlebar-dateline", ".titlebar-bar"]) {
		const scoped = decorSelectors(decor).filter((s) => s.includes(sel));
		expect(scoped.length, sel).toBeGreaterThan(0);
		for (const s of scoped) {
			expect(s.startsWith(':root[data-theme="'), s).toBe(true);
		}
	}
});
