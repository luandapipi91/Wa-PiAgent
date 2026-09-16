import { test, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { createMarkdownComponents } from "../../src/components/blocks/markdown-components";

// mock mermaid：createMarkdownComponents 的 pre 分支会走到 MermaidBlock/CodeBlockCard
mock.module("mermaid", () => ({
	default: {
		initialize: () => {},
		render: (_id: string, code: string) =>
			Promise.resolve({
				svg: `<svg width="100" height="100"><text>${code}</text></svg>`,
			}),
	},
}));

test('markdown 链接渲染为 <a target="_blank">（新标签页打开）', () => {
	const components = createMarkdownComponents("s1");
	render(
		<ReactMarkdown components={components}>
			{"详见 [官网](https://example.com)"}
		</ReactMarkdown>,
	);

	const link = screen.getByRole("link", { name: "官网" }) as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe("https://example.com");
	expect(link.getAttribute("target")).toBe("_blank");
	expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("markdown 链接保留 href，普通文本不受影响", () => {
	const components = createMarkdownComponents("s1");
	render(
		<ReactMarkdown components={components}>
			{"文本 [外部](https://example.com/path?a=1&b=2) 结尾"}
		</ReactMarkdown>,
	);

	const link = screen.getByRole("link", { name: "外部" }) as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe("https://example.com/path?a=1&b=2");
	expect(screen.getByText("文本", { exact: false })).toBeTruthy();
});

test("markdown 链接带蓝色下划线样式（可点击暗示）", () => {
	const components = createMarkdownComponents("s1");
	render(
		<ReactMarkdown components={components}>
			{"详见 [官网](https://example.com)"}
		</ReactMarkdown>,
	);

	const link = screen.getByRole("link", { name: "官网" }) as HTMLAnchorElement;
	expect(link.className).toContain("text-accent");
	expect(link.className).toContain("underline");
});

test("反引号包裹的裸 URL（行内代码）渲染为可点击链接", () => {
	const components = createMarkdownComponents("s1");
	render(
		<ReactMarkdown components={components}>
			{"请在浏览器打开（URL 不变）：`http://localhost:53213/?key=abc`"}
		</ReactMarkdown>,
	);

	const link = screen.getByRole("link", {
		name: "http://localhost:53213/?key=abc",
	}) as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe("http://localhost:53213/?key=abc");
	expect(link.getAttribute("target")).toBe("_blank");
	expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("行内代码里的非 URL 内容不变成链接", () => {
	const components = createMarkdownComponents("s1");
	render(
		<ReactMarkdown components={components}>
			{"运行 `bun run dev` 启动服务"}
		</ReactMarkdown>,
	);

	expect(screen.queryByRole("link")).toBeNull();
	expect(screen.getByText("bun run dev")).toBeTruthy();
});
