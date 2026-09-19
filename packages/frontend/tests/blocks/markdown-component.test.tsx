// 统一 markdown 组件（blocks/Markdown）契约测试。
//
// 目标：全仓库的 markdown 渲染都走这一个组件维护——各调用点的差异（包装类、组件映射覆盖、
// 插件、流式节流、文本前置整形、是否挂交互组件）全部收敛为 props。
// 这里锁定的是「默认值 + 每个 prop 真的生效」，各调用点自己的行为另由它们的既有测试兜底。
import { expect, mock, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { normalizeDialogText } from "../../src/lib/ext-dialog-text";
import { Markdown } from "../../src/components/blocks/Markdown";
import { MarkdownLink } from "../../src/components/blocks/markdown-components";

// mermaid 走真实渲染会拉 lib；组件映射里只关心「交互组件有没有挂上」
mock.module("mermaid", () => ({
	default: {
		initialize: () => {},
		render: (_id: string, code: string) =>
			Promise.resolve({ svg: `<svg><text>${code}</text></svg>` }),
	},
}));

const MERMAID = "```mermaid\ngraph TD\nA-->B\n```";

test("默认：prose 包装 + text-block testid + gfm 解析", () => {
	render(<Markdown text={"| a | b |\n| --- | --- |\n| 1 | 2 |"} sessionId="s1" />);

	const box = screen.getByTestId("text-block");
	expect(box.className).toContain("prose");
	expect(box.className).toContain("max-w-none");
	expect(box.querySelector("table")).not.toBeNull();
});

test("className / testId 可覆盖（无 testid 时不留空属性）", () => {
	render(
		<Markdown
			text="**粗体**"
			sessionId="s1"
			className="text-sm"
			testId={null}
		/>,
	);
	expect(screen.queryByTestId("text-block")).toBeNull();
	const box = screen.getByText("粗体").closest("div.text-sm");
	expect(box).not.toBeNull();
});

test("容器永远带 md-body（styles.css 的 markdown 主题配色/换行挂在这个类上，不依赖 testid）", () => {
	render(<Markdown text="**x**" sessionId="s1" testId={null} />);
	const body = document.querySelector(".md-body");
	expect(body).not.toBeNull();
	// 自定义 className 与它并存（不是覆盖）
	render(
		<Markdown text="**y**" sessionId="s1" className="text-sm" testId={null} />,
	);
	expect(document.querySelector(".md-body.text-sm")).not.toBeNull();
});

test("interactive 默认 true：代码块走交互组件（mermaid → SVG）", async () => {
	render(<Markdown text={MERMAID} sessionId="s1" />);
	// mermaid 真实渲染是异步的（懒加载 lib），给足超时（与 markdown-mermaid.test 同口径）
	expect(
		await screen.findByTestId("mermaid-svg", {}, { timeout: 5000 }),
	).toBeTruthy();
});

test("interactive=false：不挂交互组件（只读面板不引入 chip/画廊/mermaid）", () => {
	render(<Markdown text={MERMAID} sessionId="s1" interactive={false} />);
	expect(screen.queryByTestId("mermaid-svg")).toBeNull();
	expect(screen.queryByTestId("code-block-card")).toBeNull();
	// markdown 本身照旧解析
	expect(screen.getByTestId("text-block").querySelector("code")).not.toBeNull();
});

test("components：interactive=false 时只用自己的映射（AskFormCard 的 `{a}` 形态）", () => {
	render(
		<Markdown
			text="[链接](https://example.com)"
			sessionId="s1"
			interactive={false}
			components={{ a: MarkdownLink }}
		/>,
	);
	const link = screen.getByRole("link");
	expect(link.getAttribute("target")).toBe("_blank");
	expect(link.getAttribute("rel")).toContain("noopener");
});

test("transformText：入参前置整形（弹窗的终端排版归一化）", () => {
	render(
		<Markdown
			text={"│   | a | b |\n│   | --- | --- |\n│   | 1 | 2 |"}
			sessionId="s1"
			transformText={normalizeDialogText}
		/>,
	);
	expect(screen.getByTestId("text-block").querySelector("table")).not.toBeNull();
});

test("urlTransform：透传给 react-markdown（媒体 URL 改写）", () => {
	render(
		<Markdown
			text="[x](https://old.example/)"
			sessionId="s1"
			interactive={false}
			urlTransform={(url) => url.replace("old.example", "new.example")}
		/>,
	);
	expect(screen.getByRole("link").getAttribute("href")).toContain(
		"new.example",
	);
});

test("rehypePlugins：透传（FileViewer 的 rehypeRaw）", () => {
	render(
		<Markdown
			text={"<b>raw</b>"}
			sessionId="s1"
			interactive={false}
			rehypePlugins={[]}
		/>,
	);
	// 默认不解析原始 HTML
	expect(screen.getByTestId("text-block").querySelector("b")).toBeNull();
});

test("streaming：为真时节流（窗口内保持旧内容），为假时零延迟", async () => {
	// 节流：窗口内 rerender 后仍是旧内容
	const { rerender } = render(
		<Markdown text="第一段" sessionId="s1" streaming throttleMs={10_000} />,
	);
	rerender(
		<Markdown text="第二段" sessionId="s1" streaming throttleMs={10_000} />,
	);
	expect(screen.getByTestId("text-block").textContent).toContain("第一段");

	// 非流式：立即同步
	rerender(<Markdown text="第三段" sessionId="s1" />);
	expect(screen.getByTestId("text-block").textContent).toContain("第三段");
	await act(async () => {});
});

test("mediaItems 用 getter 时不影响组件映射的引用稳定（不整树 remount）", () => {
	const items = [{ url: "a.png" }] as never;
	const { rerender } = render(
		<Markdown text="**x**" sessionId="s1" mediaItems={() => items} />,
	);
	const before = screen.getByTestId("text-block").firstElementChild;
	rerender(<Markdown text="**x**" sessionId="s1" mediaItems={() => items} />);
	expect(screen.getByTestId("text-block").firstElementChild).toBe(before);
});
