// Icon 组件冒烟测试：全部图标可渲染、iconSvg 字符串与组件图形一致
import { test, expect } from "bun:test";
import { render } from "@testing-library/react";
import { Icon, iconSvg, type IconName } from "../src/components/ui/Icon";

const NAMES: IconName[] = [
	"folder",
	"folder-open",
	"file",
	"home",
	"warning",
	"lightbulb",
	"hourglass",
	"dot",
	"circle",
	"check",
	"x",
	"checkbox-checked",
	"checkbox",
	"radio-checked",
	"radio",
	"chevron-down",
	"chevron-right",
	"arrow-up",
	"upload-arrow",
	"refresh",
	"reply",
	"share",
	"edit",
	"trash",
	"eye",
	"search",
	"settings",
	"plus",
	"minus",
	"rocket",
	"bolt",
	"robot",
	"wrench",
	"image",
	"paperclip",
	"mic",
	"mic-solid",
	"monitor",
	"inbox",
	"smartphone",
	"pause",
	"play",
	"stop",
	"camera",
	"note",
	"book",
	"pin",
	"brain",
	"globe",
	"plug",
	"clipboard",
	"thought",
	"command",
];

test("全部图标都能渲染为 svg，颜色继承 currentColor", () => {
	for (const name of NAMES) {
		const { container, unmount } = render(
			<Icon name={name} testId={`icon-${name}`} />,
		);
		const svg = container.querySelector("svg")!;
		expect(svg).toBeTruthy();
		expect(svg.getAttribute("stroke")).toBe("currentColor");
		expect(svg.getAttribute("fill")).toBe("none");
		expect(svg.innerHTML.length).toBeGreaterThan(10);
		unmount();
	}
});

test("iconSvg 输出内联 svg 字符串（chip/innerHTML 场景）", () => {
	const s = iconSvg("bolt");
	expect(s).toContain("<svg");
	expect(s).toContain("currentColor");
	expect(s).toContain("<path");
	// 实心图标保留 fill 覆盖
	expect(iconSvg("dot")).toContain('fill="currentColor"');
});

test("尺寸与线宽可定制", () => {
	const { container } = render(
		<Icon name="folder" size={18} strokeWidth={2} />,
	);
	const svg = container.querySelector("svg")!;
	expect(svg.getAttribute("width")).toBe("18");
	expect(svg.getAttribute("stroke-width")).toBe("2");
});
