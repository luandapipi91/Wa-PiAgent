// 文件树后缀标签：只影响鎏金主题，其余主题不显示（虚拟滚动行高不得变）
import { test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const panelSrc = readFileSync(
	new URL("../src/components/ExplorerPanel.tsx", import.meta.url),
	"utf8",
);

beforeEach(() => {
	document.documentElement.dataset.theme = "";
});

test("后缀标签只在鎏金主题生效：样式带作用域，组件按主题条件渲染", () => {
	// CSS：只有 gilded 作用域定义了 .ep-ext，且没有任何全局 .ep-ext 规则
	expect(css).toContain(':root[data-theme="gilded"] .ep-ext {');
	expect(css).not.toMatch(/^\.ep-ext\s*\{/m);

	// 其它主题不得出现 .ep-ext 规则
	for (const theme of ["tactical", "newspaper", "pixel", "cyber", "dark"]) {
		expect(css).not.toContain(`:root[data-theme="${theme}"] .ep-ext {`);
	}

	// 组件：由 showExt（themeMode === "gilded"）门控渲染，别的主题 DOM 里没有它
	expect(panelSrc).toContain('useUiPrefsStore((s) => s.themeMode) === "gilded"');
	expect(panelSrc).toContain("{showExt && fileExtOf(node.entry) ? (");
});

test("后缀标签用 absolute 定位，不参与行高（虚拟滚动 fixedItemHeight=24）", () => {
	const gildedIdx = css.indexOf(':root[data-theme="gilded"] .ep-ext {');
	const rule = css.slice(gildedIdx, css.indexOf("}", gildedIdx));
	expect(rule).toContain("position: absolute");
	expect(rule).not.toContain("height: 24px"); // 别把行撑高
});

test("组件对新后缀标签做了关键文件判定（金底变体）", () => {
	expect(panelSrc).toContain('data-key=');
	expect(panelSrc).toContain('KEY_FILE_NAMES');
	expect(panelSrc).toContain('"AGENTS.md"');
});
