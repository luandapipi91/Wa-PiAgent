// Task 8: AnsiText 接入非颜色 SGR 属性（粗体/暗/斜体/下划线/反显）与 OSC 剥离的单测。
//
// 与 tests/ansi-text.test.ts 的分工：那份是颜色解析的历史契约（只认颜色、其余 SGR
// 丢弃），本文件覆盖新增的 `attrs: true` 渲染路径与 `AnsiText` 组件的实际接线。
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { AnsiText, parseAnsiToNodes } from "./AnsiText";

const styleOf = (node: unknown) => (node as { props: { style: Record<string, unknown> } }).props.style;

describe("parseAnsiToNodes({ attrs: true })", () => {
	test("粗体 / 下划线 / 斜体 / 暗色 / 反显 映射成 inline style", () => {
		const bold = parseAnsiToNodes("\u001b[1m粗\u001b[0m", { attrs: true });
		expect(styleOf(bold[0]).fontWeight).toBe(600);

		const multi = parseAnsiToNodes("\u001b[4;3;2;7m全\u001b[0m", { attrs: true });
		expect(styleOf(multi[0])).toMatchObject({
			textDecoration: "underline",
			fontStyle: "italic",
			opacity: 0.65,
			filter: "invert(1)",
		});
	});

	test("颜色与属性可并存在同一个 span", () => {
		const nodes = parseAnsiToNodes("\u001b[31;1m红粗\u001b[0m", { attrs: true });
		expect(nodes).toHaveLength(1);
		expect(styleOf(nodes[0])).toMatchObject({ color: "#dc2626", fontWeight: 600 });
	});

	test("先剥 OSC：OSC 8 标记消失、可见文本保留", () => {
		const nodes = parseAnsiToNodes(
			"看\u001b]8;;https://x.dev\u0007这里\u001b]8;;\u0007！",
			{ attrs: true },
		);
		expect(nodes).toEqual(["看这里！"]);
	});

	test("默认（不传 attrs）保持历史契约：非颜色 SGR 仍被丢弃", () => {
		expect(parseAnsiToNodes("\u001b[2J清屏\u001b[1m加粗\u001b[39m")).toEqual(["清屏加粗"]);
	});
});

describe("AnsiText 组件", () => {
	test("渲染非颜色属性（组件走 attrs 路径）", () => {
		const { container } = render(createElement(AnsiText, { text: "\u001b[1m粗体\u001b[0m" }));
		const span = container.querySelector("span");
		expect(span).toBeTruthy();
		expect(span?.textContent).toBe("粗体");
		expect(span?.style.fontWeight).toBe("600");
	});

	test("保留颜色语义", () => {
		const { container } = render(createElement(AnsiText, { text: "\u001b[31m红\u001b[39m" }));
		expect(container.querySelector("span")?.style.color).toBe("#dc2626");
	});
});
