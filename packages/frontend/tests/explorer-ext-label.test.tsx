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

test("后缀标签默认 display:none，只在鎏金主题下显示", () => {
	// 基础规则必须默认隐藏，否则既有主题会多出标签
	const baseRule = css.slice(css.indexOf(".ep-ext {"), css.indexOf("}", css.indexOf(".ep-ext {")));
	expect(baseRule).toContain("display: none");

	// 只有 gilded 作用域把它打开
	const gildedIdx = css.indexOf(':root[data-theme="gilded"] .ep-ext {');
	expect(gildedIdx).toBeGreaterThan(-1);
	const gildedRule = css.slice(gildedIdx, css.indexOf("}", gildedIdx));
	expect(gildedRule).toContain("display: inline-flex");

	// 其它主题不得出现 .ep-ext 规则
	for (const theme of ["tactical", "newspaper", "pixel", "cyber"]) {
		expect(css).not.toContain(`:root[data-theme="${theme}"] .ep-ext {`);
	}
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
